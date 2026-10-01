import AppKit
import SwiftUI

struct FileCommands: Commands {
    @ObservedObject var workspace = Workspace.shared

    private var document: EditorDocument? { workspace.current }

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("新增空白文件") { workspace.newBlankDocument() }
                .keyboardShortcut("n")
            Button("開啟…") { workspace.showOpenPanel() }
                .keyboardShortcut("o")
            Menu("最近開啟") {
                ForEach(workspace.recentURLs, id: \.self) { url in
                    Button(url.lastPathComponent) { workspace.open([url]) }
                }
                Divider()
                Button("清除選單") { workspace.clearRecent() }
                    .disabled(workspace.recentURLs.isEmpty)
            }
            Divider()
            Button("從圖片建立 PDF…") { workspace.showCreateFromImagesPanel() }
            Button("合併多個 PDF…") { workspace.showMergePanel() }
            Divider()
            Button("關閉分頁") { workspace.closeCurrent() }
                .keyboardShortcut("w", modifiers: [.command, .shift])
                .disabled(document == nil)
        }

        CommandGroup(replacing: .saveItem) {
            Button("儲存") { document?.save() }
                .keyboardShortcut("s")
                .disabled(document == nil)
            Button("另存新檔…") { document?.saveAs() }
                .keyboardShortcut("s", modifiers: [.command, .shift])
                .disabled(document == nil)
            Divider()
            Menu("匯出") {
                Button("匯出為圖片…") { workspace.activeSheet = .exportImages }
                Button("匯出文字…") { document?.exportText() }
                Button("匯出壓縮版本…") { document?.exportCompressed() }
            }
            .disabled(document == nil)
            Button("密碼保護…") { workspace.activeSheet = .password }
                .disabled(document == nil)
        }

        CommandGroup(replacing: .printItem) {
            Button("列印…") { document?.print() }
                .keyboardShortcut("p")
                .disabled(document == nil)
        }
    }
}

struct EditCommands: Commands {
    @ObservedObject var workspace = Workspace.shared

    var body: some Commands {
        CommandGroup(replacing: .undoRedo) {
            Button("復原") { undoOrForward(redo: false) }
                .keyboardShortcut("z")
            Button("重做") { undoOrForward(redo: true) }
                .keyboardShortcut("z", modifiers: [.command, .shift])
        }
        CommandGroup(after: .pasteboard) {
            Divider()
            Button("刪除選取的註解") { workspace.current?.deleteSelectedAnnotation() }
                .disabled(workspace.current == nil)
            Button("尋找…") {
                workspace.showSidebar = true
                workspace.sidebarTab = .search
            }
            .keyboardShortcut("f")
            .disabled(workspace.current == nil)
            Button("尋找下一個") { workspace.current?.nextSearchResult(1) }
                .keyboardShortcut("g")
                .disabled(workspace.current == nil)
            Button("尋找上一個") { workspace.current?.nextSearchResult(-1) }
                .keyboardShortcut("g", modifiers: [.command, .shift])
                .disabled(workspace.current == nil)
        }
    }

    /// 正在編輯文字欄位時交給欄位本身復原，否則使用文件的復原紀錄。
    private func undoOrForward(redo: Bool) {
        if let responder = NSApp.keyWindow?.firstResponder as? NSTextView, responder.isEditable {
            NSApp.sendAction(redo ? Selector(("redo:")) : Selector(("undo:")), to: nil, from: nil)
            return
        }
        guard let manager = workspace.current?.undoManager else { return }
        if redo {
            if manager.canRedo { manager.redo() }
        } else if manager.canUndo {
            manager.undo()
        }
    }
}

struct ViewCommands: Commands {
    @ObservedObject var workspace = Workspace.shared

    private var document: EditorDocument? { workspace.current }

    var body: some Commands {
        CommandGroup(after: .sidebar) {
            Button(workspace.showSidebar ? "隱藏側欄" : "顯示側欄") { workspace.showSidebar.toggle() }
                .keyboardShortcut("s", modifiers: [.command, .control])
            Divider()
            Button("放大") { document?.pdfView?.zoomIn(nil) }
                .keyboardShortcut("=")
            Button("縮小") { document?.pdfView?.zoomOut(nil) }
                .keyboardShortcut("-")
            Button("實際大小") { document?.pdfView?.scaleFactor = 1 }
                .keyboardShortcut("0")
            Button("符合視窗") { document?.pdfView?.autoScales = true }
                .keyboardShortcut("9")
            Divider()
            if let document {
                Menu("頁面顯示方式") { DisplayModeMenu(document: document) }
            }
            Divider()
            Button("上一頁") { document?.pdfView?.goToPreviousPage(nil) }
                .keyboardShortcut(.upArrow, modifiers: [.command, .option])
            Button("下一頁") { document?.pdfView?.goToNextPage(nil) }
                .keyboardShortcut(.downArrow, modifiers: [.command, .option])
            Button("第一頁") { document?.pdfView?.goToFirstPage(nil) }
                .keyboardShortcut(.upArrow, modifiers: [.command])
            Button("最後一頁") { document?.pdfView?.goToLastPage(nil) }
                .keyboardShortcut(.downArrow, modifiers: [.command])
            Button("前往頁面…") { document?.promptGoToPage() }
                .keyboardShortcut("j", modifiers: [.command, .option])
        }
    }
}

struct PageCommands: Commands {
    @ObservedObject var workspace = Workspace.shared

    private var document: EditorDocument? { workspace.current }

    var body: some Commands {
        CommandMenu("頁面") {
            Group {
                Button("向右旋轉") { document.map { $0.rotatePages($0.targetPageIndices, by: 90) } }
                    .keyboardShortcut("r")
                Button("向左旋轉") { document.map { $0.rotatePages($0.targetPageIndices, by: -90) } }
                    .keyboardShortcut("l")
                Divider()
                Button("插入空白頁") { document.map { $0.insertBlankPage(after: $0.targetPageIndices.max()) } }
                    .keyboardShortcut("n", modifiers: [.command, .shift])
                Button("從檔案插入頁面…") { document?.showInsertPagesPanel() }
                Button("複製頁面") { document.map { $0.duplicatePages($0.targetPageIndices) } }
                Button("刪除頁面") { document.map { $0.deletePages($0.targetPageIndices) } }
                    .keyboardShortcut(.delete, modifiers: [.command])
            }
            .disabled(document == nil)
            Divider()
            Group {
                Button("擷取頁面為新 PDF…") { document.map { $0.extractPages($0.targetPageIndices) } }
                Button("分割 PDF…") { workspace.activeSheet = .split }
                Button("合併多個 PDF…") { workspace.showMergePanel() }
            }
            .disabled(document == nil)
        }
    }
}

struct ToolCommands: Commands {
    @ObservedObject var workspace = Workspace.shared
    @ObservedObject var tools = ToolState.shared

    private var document: EditorDocument? { workspace.current }

    var body: some Commands {
        CommandMenu("工具") {
            ForEach(Tool.allCases) { tool in
                toolButton(tool)
            }
            Divider()
            Group {
                Button("簽名…") { workspace.activeSheet = .signatures }
                Button("浮水印…") { workspace.activeSheet = .watermark }
                Button("頁碼與頁首頁尾…") { workspace.activeSheet = .pageNumbers }
                Button("移除浮水印與頁碼") { document?.removeStamps() }
                Button("新增書籤") { document?.addBookmark() }
                    .keyboardShortcut("d")
            }
            .disabled(document == nil)
            Divider()
            Group {
                Button("套用遮蓋（永久移除內容）") { document?.applyRedactions() }
                Button("文字辨識（OCR）…") { workspace.activeSheet = .ocr }
                Button("平面化所有註解與表單") { document?.flattenAll() }
            }
            .disabled(document == nil)
        }
    }

    @ViewBuilder
    private func toolButton(_ tool: Tool) -> some View {
        let button = Button {
            if tool == .signature { workspace.activeSheet = .signatures }
            tools.pendingImage = nil
            tools.select(tool)
        } label: {
            if tools.tool == tool {
                Label(tool.title, systemImage: "checkmark")
            } else {
                Text(tool.title)
            }
        }
        if let key = tool.shortcut {
            button.keyboardShortcut(key, modifiers: [.command, .option])
        } else {
            button
        }
    }
}
