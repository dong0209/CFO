import AppKit
import UniformTypeIdentifiers

/// 開檔、存檔與簡易對話框。
@MainActor
enum Panels {
    static func openPDFs(multiple: Bool = true, title: String = "開啟 PDF") -> [URL] {
        let panel = NSOpenPanel()
        panel.title = title
        panel.allowedContentTypes = [.pdf]
        panel.allowsMultipleSelection = multiple
        panel.canChooseDirectories = false
        return panel.runModal() == .OK ? panel.urls : []
    }

    static func openImages(multiple: Bool = true, title: String = "選擇圖片") -> [URL] {
        let panel = NSOpenPanel()
        panel.title = title
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = multiple
        return panel.runModal() == .OK ? panel.urls : []
    }

    static func chooseFolder(title: String) -> URL? {
        let panel = NSOpenPanel()
        panel.title = title
        panel.prompt = "選擇"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        return panel.runModal() == .OK ? panel.url : nil
    }

    static func save(title: String, suggestedName: String, type: UTType = .pdf) -> URL? {
        let panel = NSSavePanel()
        panel.title = title
        panel.nameFieldStringValue = suggestedName
        panel.allowedContentTypes = [type]
        panel.canCreateDirectories = true
        return panel.runModal() == .OK ? panel.url : nil
    }

    /// 單行或多行文字輸入。
    static func promptText(title: String, message: String = "", initial: String = "", multiline: Bool = false, secure: Bool = false) -> String? {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "確定")
        alert.addButton(withTitle: "取消")

        let valueProvider: () -> String
        if multiline {
            let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 320, height: 120))
            scroll.hasVerticalScroller = true
            scroll.borderType = .bezelBorder
            let textView = NSTextView(frame: scroll.bounds)
            textView.string = initial
            textView.isRichText = false
            textView.font = .systemFont(ofSize: 13)
            textView.autoresizingMask = [.width]
            scroll.documentView = textView
            alert.accessoryView = scroll
            alert.window.initialFirstResponder = textView
            valueProvider = { textView.string }
        } else {
            let field: NSTextField = secure ? NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24)) : NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
            field.stringValue = initial
            alert.accessoryView = field
            alert.window.initialFirstResponder = field
            valueProvider = { field.stringValue }
        }
        return alert.runModal() == .alertFirstButtonReturn ? valueProvider() : nil
    }

    static func confirm(title: String, message: String, confirm: String = "確定", destructive: Bool = false) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = destructive ? .critical : .warning
        let button = alert.addButton(withTitle: confirm)
        button.hasDestructiveAction = destructive
        alert.addButton(withTitle: "取消")
        return alert.runModal() == .alertFirstButtonReturn
    }

    enum UnsavedChoice { case save, discard, cancel }

    static func askToSave(name: String) -> UnsavedChoice {
        let alert = NSAlert()
        alert.messageText = "要儲存「\(name)」的變更嗎？"
        alert.informativeText = "如果不儲存，所做的變更將會遺失。"
        alert.addButton(withTitle: "儲存")
        alert.addButton(withTitle: "取消")
        let discard = alert.addButton(withTitle: "不儲存")
        discard.hasDestructiveAction = true
        switch alert.runModal() {
        case .alertFirstButtonReturn: return .save
        case .alertThirdButtonReturn: return .discard
        default: return .cancel
        }
    }

    static func showError(_ error: Error, title: String = "發生錯誤") {
        showMessage(title: title, message: error.localizedDescription, style: .critical)
    }

    static func showMessage(title: String, message: String, style: NSAlert.Style = .informational) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = style
        alert.runModal()
    }
}
