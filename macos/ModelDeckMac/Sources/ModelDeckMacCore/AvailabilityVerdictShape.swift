import CoreGraphics
import Foundation

/// Issue #242: the ONE verdict → shape coding, shared by the menu bar's
/// status dot (issue #235, `MenuBarIconRenderer`) and the deck column chip's
/// dot. Traffic-sign shape language — green filled circle, yellow triangle,
/// red octagon, muted hollow ring for "no data" — so color is never the only
/// signal, which is what lets the deck chip drop the verdict word by default
/// (#242) without regressing accessibility. Lives in Core so the mapping and
/// geometry are unit-testable and the two surfaces can never drift apart.
public enum AvailabilityVerdictShape: Equatable, Sendable, CaseIterable {
    /// GREEN — filled circle.
    case filledCircle
    /// YELLOW — filled triangle (apex up).
    case triangle
    /// RED — filled octagon (stop-sign).
    case octagon
    /// Nil verdict — hollow stroked ring: data hasn't arrived or no account
    /// qualified, and neither surface may claim a health it can't compute.
    case hollowRing

    /// The single source of truth for the coding. Both renderers call this;
    /// parity is structural, not a convention.
    public static func shape(for verdict: AvailabilityVerdict?) -> AvailabilityVerdictShape {
        switch verdict {
        case .green: return .filledCircle
        case .yellow: return .triangle
        case .red: return .octagon
        case nil: return .hollowRing
        }
    }

    /// True when the shape renders as an outline (the muted no-data ring);
    /// every real-verdict shape renders filled.
    public var isStroked: Bool { self == .hollowRing }

    /// The ring's stroke width and centerline inset (the #235 menu-bar
    /// values, kept as the shared constants).
    public static let ringLineWidth: CGFloat = 1.5
    public static let ringInset: CGFloat = 0.75

    /// The shape's path filling `rect`, authored in AppKit's UNFLIPPED
    /// coordinates (y up — the triangle's apex sits at `maxY`). SwiftUI
    /// callers must flip about the rect's vertical midline. For
    /// `hollowRing` this is the centerline oval (inset by `ringInset`)
    /// meant to be STROKED at `ringLineWidth`, not filled.
    public func path(in rect: CGRect) -> CGPath {
        switch self {
        case .filledCircle:
            return CGPath(ellipseIn: rect, transform: nil)
        case .hollowRing:
            return CGPath(
                ellipseIn: rect.insetBy(dx: Self.ringInset, dy: Self.ringInset),
                transform: nil
            )
        case .triangle:
            let path = CGMutablePath()
            path.move(to: CGPoint(x: rect.midX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.minY))
            path.closeSubpath()
            return path
        case .octagon:
            let inset = rect.width * 0.29
            let points = [
                CGPoint(x: rect.minX + inset, y: rect.minY),
                CGPoint(x: rect.maxX - inset, y: rect.minY),
                CGPoint(x: rect.maxX, y: rect.minY + inset),
                CGPoint(x: rect.maxX, y: rect.maxY - inset),
                CGPoint(x: rect.maxX - inset, y: rect.maxY),
                CGPoint(x: rect.minX + inset, y: rect.maxY),
                CGPoint(x: rect.minX, y: rect.maxY - inset),
                CGPoint(x: rect.minX, y: rect.minY + inset),
            ]
            let path = CGMutablePath()
            path.addLines(between: points)
            path.closeSubpath()
            return path
        }
    }
}

/// Issue #242: what the deck chip renders for a given labels setting — the
/// shape-coded dot always; the verdict word only when the Settings →
/// General → Accessibility "Show health verdict labels" toggle is on.
/// Core-testable so both rendering states are unit tested without SwiftUI.
/// Display-only either way: the tooltip, the click-open detail popover, and
/// the VoiceOver summary all come from `AvailabilityHealthPresentation` and
/// are untouched by the toggle.
public struct AvailabilityHealthChipDisplay: Equatable, Sendable {
    public let shape: AvailabilityVerdictShape
    /// The verdict word beside the dot; nil renders dot-only (the default).
    public let word: String?

    public init(shape: AvailabilityVerdictShape, word: String?) {
        self.shape = shape
        self.word = word
    }

    public static func make(
        verdict: AvailabilityVerdict?,
        chipWord: String,
        showsVerdictLabels: Bool
    ) -> AvailabilityHealthChipDisplay {
        AvailabilityHealthChipDisplay(
            shape: .shape(for: verdict),
            word: showsVerdictLabels ? chipWord : nil
        )
    }
}
