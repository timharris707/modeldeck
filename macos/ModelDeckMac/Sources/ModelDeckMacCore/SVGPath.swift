import CoreGraphics
import Foundation

/// Minimal SVG path-data parser (the `d` attribute) producing a `CGPath`.
/// Supports M/L/H/V/C/S/Q/T/A/Z in absolute and relative form. Originally
/// built to render the vector provider marks; those were replaced by the
/// official desktop-app icons (issue #103), leaving this as a general
/// utility with test coverage but no production caller at present.
public enum SVGPath {
    public static func cgPath(_ d: String) -> CGPath? {
        var scanner = Tokenizer(d)
        let path = CGMutablePath()
        var command: Character?
        var current = CGPoint.zero
        var subpathStart = CGPoint.zero
        var lastControl: CGPoint?
        var lastCommand: Character = " "

        func reflectedControl() -> CGPoint {
            guard let lastControl else { return current }
            return CGPoint(x: 2 * current.x - lastControl.x, y: 2 * current.y - lastControl.y)
        }

        while true {
            if let next = scanner.peekCommand() {
                command = next
                scanner.consumeCommand()
            } else if !scanner.hasMoreNumbers {
                break
            } else if command == nil {
                return nil
            } else if command == "M" {
                command = "L" // implicit lineto after moveto
            } else if command == "m" {
                command = "l"
            }
            guard let cmd = command else { return nil }
            let relative = cmd.isLowercase
            let upper = Character(cmd.uppercased())

            func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
            }

            switch upper {
            case "M":
                guard let x = scanner.number(), let y = scanner.number() else { return nil }
                current = point(x, y)
                subpathStart = current
                path.move(to: current)
                lastControl = nil
            case "L":
                guard let x = scanner.number(), let y = scanner.number() else { return nil }
                current = point(x, y)
                path.addLine(to: current)
                lastControl = nil
            case "H":
                guard let x = scanner.number() else { return nil }
                current = CGPoint(x: relative ? current.x + x : x, y: current.y)
                path.addLine(to: current)
                lastControl = nil
            case "V":
                guard let y = scanner.number() else { return nil }
                current = CGPoint(x: current.x, y: relative ? current.y + y : y)
                path.addLine(to: current)
                lastControl = nil
            case "C":
                guard let x1 = scanner.number(), let y1 = scanner.number(),
                      let x2 = scanner.number(), let y2 = scanner.number(),
                      let x = scanner.number(), let y = scanner.number() else { return nil }
                let c1 = point(x1, y1)
                let c2 = point(x2, y2)
                current = point(x, y)
                path.addCurve(to: current, control1: c1, control2: c2)
                lastControl = c2
            case "S":
                guard let x2 = scanner.number(), let y2 = scanner.number(),
                      let x = scanner.number(), let y = scanner.number() else { return nil }
                let c1 = "CS".contains(Character(lastCommand.uppercased())) ? reflectedControl() : current
                let c2 = point(x2, y2)
                current = point(x, y)
                path.addCurve(to: current, control1: c1, control2: c2)
                lastControl = c2
            case "Q":
                guard let x1 = scanner.number(), let y1 = scanner.number(),
                      let x = scanner.number(), let y = scanner.number() else { return nil }
                let c = point(x1, y1)
                current = point(x, y)
                path.addQuadCurve(to: current, control: c)
                lastControl = c
            case "T":
                guard let x = scanner.number(), let y = scanner.number() else { return nil }
                let c = "QT".contains(Character(lastCommand.uppercased())) ? reflectedControl() : current
                current = point(x, y)
                path.addQuadCurve(to: current, control: c)
                lastControl = c
            case "A":
                guard let rx = scanner.number(), let ry = scanner.number(),
                      let rotation = scanner.number(),
                      let largeArc = scanner.flag(), let sweep = scanner.flag(),
                      let x = scanner.number(), let y = scanner.number() else { return nil }
                let end = point(x, y)
                addArc(
                    to: path, from: current, to: end,
                    rx: rx, ry: ry, rotationDegrees: rotation,
                    largeArc: largeArc, sweep: sweep
                )
                current = end
                lastControl = nil
            case "Z":
                path.closeSubpath()
                current = subpathStart
                lastControl = nil
            default:
                return nil
            }
            lastCommand = cmd
        }
        return path
    }

    // W3C SVG spec F.6.5 — endpoint to center arc parameterization,
    // approximated with cubic beziers per quarter turn.
    private static func addArc(
        to path: CGMutablePath, from start: CGPoint, to end: CGPoint,
        rx: CGFloat, ry: CGFloat, rotationDegrees: CGFloat,
        largeArc: Bool, sweep: Bool
    ) {
        var rx = abs(rx), ry = abs(ry)
        if rx == 0 || ry == 0 || start == end {
            path.addLine(to: end)
            return
        }
        let phi = rotationDegrees * .pi / 180
        let cosPhi = cos(phi), sinPhi = sin(phi)
        let dx = (start.x - end.x) / 2, dy = (start.y - end.y) / 2
        let x1p = cosPhi * dx + sinPhi * dy
        let y1p = -sinPhi * dx + cosPhi * dy
        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
        if lambda > 1 {
            let scale = sqrt(lambda)
            rx *= scale
            ry *= scale
        }
        let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
        let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
        var factor = den == 0 ? 0 : sqrt(max(0, num / den))
        if largeArc == sweep { factor = -factor }
        let cxp = factor * rx * y1p / ry
        let cyp = -factor * ry * x1p / rx
        let cx = cosPhi * cxp - sinPhi * cyp + (start.x + end.x) / 2
        let cy = sinPhi * cxp + cosPhi * cyp + (start.y + end.y) / 2

        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let dot = ux * vx + uy * vy
            let len = sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
            guard len > 0 else { return 0 }
            var a = acos(min(max(dot / len, -1), 1))
            if ux * vy - uy * vx < 0 { a = -a }
            return a
        }

        let startAngle = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
        var delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
        if !sweep && delta > 0 { delta -= 2 * .pi }
        if sweep && delta < 0 { delta += 2 * .pi }

        let segments = max(1, Int(ceil(abs(delta) / (.pi / 2))))
        let segmentDelta = delta / CGFloat(segments)
        var theta = startAngle
        var from = start
        for _ in 0..<segments {
            let thetaEnd = theta + segmentDelta
            let t = 4 / 3 * tan(segmentDelta / 4)

            func pointOn(_ angle: CGFloat) -> CGPoint {
                CGPoint(
                    x: cx + rx * cos(angle) * cosPhi - ry * sin(angle) * sinPhi,
                    y: cy + rx * cos(angle) * sinPhi + ry * sin(angle) * cosPhi
                )
            }
            func derivative(_ angle: CGFloat) -> CGPoint {
                CGPoint(
                    x: -rx * sin(angle) * cosPhi - ry * cos(angle) * sinPhi,
                    y: -rx * sin(angle) * sinPhi + ry * cos(angle) * cosPhi
                )
            }

            let to = pointOn(thetaEnd)
            let d1 = derivative(theta)
            let d2 = derivative(thetaEnd)
            let c1 = CGPoint(x: from.x + t * d1.x, y: from.y + t * d1.y)
            let c2 = CGPoint(x: to.x - t * d2.x, y: to.y - t * d2.y)
            path.addCurve(to: to, control1: c1, control2: c2)
            theta = thetaEnd
            from = to
        }
    }

    /// Tokenizer over path data: commands, numbers, and arc flags.
    private struct Tokenizer {
        private let chars: [Character]
        private var index = 0

        init(_ string: String) {
            chars = Array(string)
        }

        private mutating func skipSeparators() {
            while index < chars.count, chars[index] == " " || chars[index] == "," || chars[index] == "\n" || chars[index] == "\t" || chars[index] == "\r" {
                index += 1
            }
        }

        mutating func peekCommand() -> Character? {
            skipSeparators()
            guard index < chars.count else { return nil }
            let c = chars[index]
            return c.isLetter ? c : nil
        }

        mutating func consumeCommand() {
            index += 1
        }

        var hasMoreNumbers: Bool {
            mutating get {
                skipSeparators()
                guard index < chars.count else { return false }
                let c = chars[index]
                return c.isNumber || c == "-" || c == "+" || c == "."
            }
        }

        mutating func number() -> CGFloat? {
            skipSeparators()
            let start = index
            guard start < chars.count else { return nil }
            var seenDot = false
            var seenExponent = false
            var end = start
            if chars[end] == "-" || chars[end] == "+" { end += 1 }
            loop: while end < chars.count {
                let c = chars[end]
                switch c {
                case "0"..."9":
                    end += 1
                case ".":
                    if seenDot || seenExponent { break loop }
                    seenDot = true
                    end += 1
                case "e", "E":
                    if seenExponent { break loop }
                    seenExponent = true
                    end += 1
                    if end < chars.count, chars[end] == "-" || chars[end] == "+" { end += 1 }
                default:
                    break loop
                }
            }
            guard end > start, let value = Double(String(chars[start..<end])) else { return nil }
            index = end
            return CGFloat(value)
        }

        /// Arc flags are single characters '0'/'1' and may be run together.
        mutating func flag() -> Bool? {
            skipSeparators()
            guard index < chars.count else { return nil }
            switch chars[index] {
            case "0": index += 1; return false
            case "1": index += 1; return true
            default: return nil
            }
        }
    }
}
