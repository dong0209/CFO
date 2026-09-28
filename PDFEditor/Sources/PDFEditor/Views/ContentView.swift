import PDFEditorCore
import PDFKit
import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @ObservedObject var workspace = Workspace.shared
    @State private var isDropTargeted = false

    var body: some View {
        VStack(spacing: 0) {
            if workspace.documents.isEmpty {
                WelcomeView()
            } else {
                TabBar()
                Divider()
                if let document = workspace.current {
                    EditorView(document: document)
                        .id(document.id)
                }
            }
        }
        .frame(minWidth: 900, minHeight: 600)
        .navigationTitle(workspace.current.map { ($0.isDirty ? "● " : "") + $0.displayName } ?? "PDF 編輯器")
        .overlay {
            if isDropTargeted {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 4, dash: [10, 6]))
                    .padding(8)
                    .allowsHitTesting(false)
            }
        }
        .overlay {
            if let progress = workspace.progress {
                ProgressOverlay(progress: progress)
            }
        }
        .onDrop(of: [.fileURL], isTargeted: $isDropTargeted) { providers in
            loadDroppedURLs(providers)
            return true
        }
        .sheet(item: $workspace.activeSheet) { sheet in
            if let document = workspace.current {
                SheetHost(sheet: sheet, document: document)
            } else if sheet == .signatures {
                SignatureSheet()
            }
        }
    }

    private func loadDroppedURLs(_ providers: [NSItemProvider]) {
        for provider in providers {
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                guard let url else { return }
                DispatchQueue.main.async {
                    Workspace.shared.open([url])
                }
            }
        }
    }
}

private struct SheetHost: View {
    let sheet: SheetKind
    @ObservedObject var document: EditorDocument

    var body: some View {
        switch sheet {
        case .watermark: WatermarkSheet(document: document)
        case .pageNumbers: PageNumberSheet(document: document)
        case .signatures: SignatureSheet()
        case .password: PasswordSheet(document: document)
        case .split: SplitSheet(document: document)
        case .exportImages: ExportImagesSheet(document: document)
        case .ocr: OCRSheet(document: document)
        }
    }
}

private struct ProgressOverlay: View {
    let progress: ProgressState

    var body: some View {
        ZStack {
            Color.black.opacity(0.25).ignoresSafeArea()
            VStack(spacing: 12) {
                Text(progress.title).font(.headline)
                ProgressView(value: progress.fraction)
                    .frame(width: 280)
                Text("\(progress.completed) / \(progress.total)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            .padding(24)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

// MARK: - 分頁列

private struct TabBar: View {
    @ObservedObject var workspace = Workspace.shared

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(workspace.documents) { document in
                    TabItem(document: document, isSelected: document.id == workspace.current?.id)
                }
                Button {
                    workspace.showOpenPanel()
                } label: {
                    Image(systemName: "plus")
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.borderless)
                .help("開啟 PDF")
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

private struct TabItem: View {
    @ObservedObject var document: EditorDocument
    let isSelected: Bool
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "doc.richtext")
                .foregroundStyle(.secondary)
            Text(document.displayName)
                .lineLimit(1)
                .frame(maxWidth: 200, alignment: .leading)
            Button {
                Workspace.shared.close(document)
            } label: {
                Image(systemName: document.isDirty && !hovering ? "circle.fill" : "xmark")
                    .font(.system(size: document.isDirty && !hovering ? 7 : 10, weight: .bold))
                    .frame(width: 16, height: 16)
            }
            .buttonStyle(.borderless)
            .help("關閉分頁")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(isSelected ? Color.accentColor.opacity(0.18) : (hovering ? Color.primary.opacity(0.06) : .clear))
        )
        .contentShape(Rectangle())
        .onTapGesture { Workspace.shared.currentID = document.id }
        .onHover { hovering = $0 }
    }
}

// MARK: - 編輯畫面

struct EditorView: View {
    @ObservedObject var document: EditorDocument
    @ObservedObject var workspace = Workspace.shared

    var body: some View {
        VStack(spacing: 0) {
            ToolPalette(document: document)
            Divider()
            HSplitView {
                if workspace.showSidebar {
                    SidebarView(document: document)
                        .frame(minWidth: 200, idealWidth: 240, maxWidth: 400)
                }
                PDFKitView(document: document)
                    .frame(minWidth: 400)
            }
            Divider()
            StatusBar(document: document)
        }
        .toolbar {
            ToolbarItemGroup(placement: .navigation) {
                Button {
                    workspace.showSidebar.toggle()
                } label: {
                    Label("側欄", systemImage: "sidebar.left")
                }
                .help("顯示／隱藏側欄")
            }
            ToolbarItemGroup {
                Button { document.pdfView?.zoomOut(nil) } label: { Label("縮小", systemImage: "minus.magnifyingglass") }
                    .help("縮小")
                Button { document.pdfView?.zoomIn(nil) } label: { Label("放大", systemImage: "plus.magnifyingglass") }
                    .help("放大")
                Button { document.pdfView?.autoScales = true } label: { Label("符合視窗", systemImage: "arrow.up.left.and.arrow.down.right") }
                    .help("符合視窗大小")
                Menu {
                    DisplayModeMenu(document: document)
                } label: {
                    Label("顯示方式", systemImage: "rectangle.split.2x1")
                }
                .help("頁面顯示方式")
                Button {
                    document.rotatePages(document.targetPageIndices, by: -90)
                } label: { Label("向左旋轉", systemImage: "rotate.left") }
                    .help("向左旋轉頁面")
                Button {
                    document.rotatePages(document.targetPageIndices, by: 90)
                } label: { Label("向右旋轉", systemImage: "rotate.right") }
                    .help("向右旋轉頁面")
                Button {
                    workspace.showSidebar = true
                    workspace.sidebarTab = .search
                } label: { Label("搜尋", systemImage: "magnifyingglass") }
                    .help("搜尋文件")
                Button { document.save() } label: { Label("儲存", systemImage: "square.and.arrow.down") }
                    .help("儲存 (⌘S)")
            }
        }
    }
}

struct DisplayModeMenu: View {
    @ObservedObject var document: EditorDocument

    var body: some View {
        Button("單頁") { setMode(.singlePage, book: false) }
        Button("單頁連續捲動") { setMode(.singlePageContinuous, book: false) }
        Button("雙頁") { setMode(.twoUp, book: false) }
        Button("雙頁連續捲動") { setMode(.twoUpContinuous, book: false) }
        Button("書本模式（封面單獨顯示）") { setMode(.twoUpContinuous, book: true) }
        Divider()
        Button("水平捲動") {
            document.pdfView?.displayMode = .singlePageContinuous
            document.pdfView?.displayDirection = .horizontal
        }
    }

    private func setMode(_ mode: PDFDisplayMode, book: Bool) {
        guard let view = document.pdfView else { return }
        view.displayDirection = .vertical
        view.displayMode = mode
        view.displaysAsBook = book
        view.autoScales = true
    }
}

private struct StatusBar: View {
    @ObservedObject var document: EditorDocument
    @ObservedObject var tools = ToolState.shared

    var body: some View {
        HStack(spacing: 12) {
            Button {
                document.promptGoToPage()
            } label: {
                Text("第 \(document.currentPageIndex + 1) 頁，共 \(document.pageCount) 頁")
                    .monospacedDigit()
            }
            .buttonStyle(.borderless)
            .help("前往頁面…")

            if document.security != nil {
                Label("存檔時加密", systemImage: "lock.fill")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Text(hint)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .font(.caption)
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    }

    private var hint: String {
        switch tools.tool {
        case .select: return "點選註解可拖曳移動、按 Delete 刪除；雙擊文字註解可編輯"
        case .highlight, .underline, .strikeout: return "拖曳選取文字即可加上\(tools.tool.title)"
        case .note, .textBox: return "在頁面上點一下以新增\(tools.tool.title)"
        case .ink: return "按住滑鼠拖曳手繪"
        case .rectangle, .ellipse, .line, .arrow, .whiteout: return "拖曳以繪製\(tools.tool.title)"
        case .redact: return "框選要移除的區域，再到「工具 ▸ 套用遮蓋」永久移除內容"
        case .image: return tools.pendingImage == nil ? "在頁面上點一下以選擇並放置圖片" : "在頁面上點一下以放置圖片"
        case .signature: return tools.pendingImage == nil ? "在頁面上點一下以選擇簽名" : "在頁面上點一下以放置簽名"
        case .eraser: return "點一下註解即可刪除"
        }
    }
}
