import AppKit
import PDFEditorCore
import SwiftUI

@main
struct PDFEditorApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup("PDF 編輯器") {
            ContentView()
        }
        .commands {
            FileCommands()
            EditCommands()
            ViewCommands()
            PageCommands()
            ToolCommands()
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        // 以 swift run 直接執行時也顯示為一般 App（有 Dock 圖示與選單列）。
        NSApp.setActivationPolicy(.regular)
        // 使用分頁列管理文件，關閉系統的視窗分頁功能以免混淆。
        NSWindow.allowsAutomaticWindowTabbing = false
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.activate(ignoringOtherApps: true)
        // 先前下載過的開源字型註冊給本程式使用（文字方塊需要）
        FontResolver.shared.registerCachedFonts()
        let arguments = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("-") }
        let urls = arguments.map { URL(fileURLWithPath: $0) }.filter { FileManager.default.fileExists(atPath: $0.path) }
        if !urls.isEmpty {
            MainActor.assumeIsolated { Workspace.shared.open(urls) }
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        MainActor.assumeIsolated { Workspace.shared.open(urls) }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        MainActor.assumeIsolated { Workspace.shared.closeAllForTermination() } ? .terminateNow : .terminateCancel
    }
}
