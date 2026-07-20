import Foundation
import ModelDeckMacCore

/// Issue #8, step 2 — runs the provider's own login command in Terminal.app.
/// The command comes verbatim from the daemon's `GET /api/accounts/:id/login`
/// (always a login/status invocation, never a logout) and executes in the
/// user's own terminal session so the provider's browser OAuth flow behaves
/// exactly as it does when run by hand. ModelDeck never proxies or observes
/// the login itself.
struct TerminalLoginLauncher: LoginLaunching {
    func launchLogin(command: String) throws {
        // AppleScript string literal escaping: backslashes first, then quotes.
        let escaped = command
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let script = """
        tell application "Terminal"
            activate
            do script "\(escaped)"
        end tell
        """
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        // Fire and forget: the first run can sit on macOS's automation
        // permission prompt, so never block the main actor waiting for it.
        // The sheet keeps the command visible with a Copy button as the
        // fallback if the user denies Terminal automation.
        try process.run()
    }
}
