import PDFEditorCore
import PDFKit
import SwiftUI

struct SidebarView: View {
    @ObservedObject var document: EditorDocument
    @ObservedObject var workspace = Workspace.shared

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $workspace.sidebarTab) {
                ForEach(SidebarTab.allCases) { tab in
                    Image(systemName: tab.symbol)
                        .help(tab.title)
                        .tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(8)

            Divider()

            switch workspace.sidebarTab {
            case .thumbnails: ThumbnailSidebar(document: document)
            case .outline: OutlineSidebar(document: document)
            case .annotations: AnnotationSidebar(document: document)
            case .search: SearchSidebar(document: document)
            }
        }
    }
}

// MARK: - 縮圖

private struct PageItem: Identifiable {
    let id: ObjectIdentifier
    let index: Int
    let page: PDFPage
}

private struct ThumbnailSidebar: View {
    @ObservedObject var document: EditorDocument

    private var items: [PageItem] {
        document.pages.enumerated().map { PageItem(id: ObjectIdentifier($0.element), index: $0.offset, page: $0.element) }
    }

    var body: some View {
        let pageItems = items
        ScrollViewReader { proxy in
            List(selection: $document.selectedPageIDs) {
                ForEach(pageItems) { item in
                    ThumbnailRow(page: item.page, index: item.index, isCurrent: item.index == document.currentPageIndex, revision: document.revision)
                        .tag(item.id)
                        .id(item.id)
                        .contextMenu { PageContextMenu(document: document, index: item.index) }
                }
                .onMove { source, destination in
                    document.movePages(from: source, to: destination)
                }
            }
            .listStyle(.sidebar)
            .onChange(of: document.selectedPageIDs) { selection in
                guard selection.count == 1, let id = selection.first,
                      let item = pageItems.first(where: { $0.id == id }) else { return }
                document.goToPage(item.index)
            }
            .onChange(of: document.currentPageIndex) { index in
                guard index < pageItems.count else { return }
                proxy.scrollTo(pageItems[index].id)
            }
        }
        .safeAreaInset(edge: .bottom) {
            HStack {
                Button { document.insertBlankPage(after: document.targetPageIndices.max()) } label: { Image(systemName: "plus") }
                    .help("插入空白頁")
                Button { document.deletePages(document.targetPageIndices) } label: { Image(systemName: "minus") }
                    .help("刪除選取的頁面")
                Button { document.rotatePages(document.targetPageIndices, by: 90) } label: { Image(systemName: "rotate.right") }
                    .help("向右旋轉")
                Spacer()
                Text(document.selectedPageIDs.isEmpty ? "" : "已選 \(document.selectedPageIDs.count) 頁")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .padding(8)
            .background(.bar)
        }
    }
}

private struct ThumbnailRow: View {
    let page: PDFPage
    let index: Int
    let isCurrent: Bool
    /// 讓內容改變時重新產生縮圖。
    let revision: Int

    var body: some View {
        VStack(spacing: 4) {
            Image(nsImage: page.thumbnail(of: CGSize(width: 150, height: 200), for: .cropBox))
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: 150, maxHeight: 200)
                .shadow(color: .black.opacity(0.2), radius: 2, y: 1)
                .overlay(
                    Rectangle().stroke(isCurrent ? Color.accentColor : .clear, lineWidth: 2)
                )
            Text("\(index + 1)")
                .font(.caption)
                .foregroundStyle(isCurrent ? Color.accentColor : .secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
    }
}

struct PageContextMenu: View {
    @ObservedObject var document: EditorDocument
    let index: Int

    /// 右鍵點在已選取的頁面時作用於全部選取頁，否則只作用於該頁。
    private var targets: [Int] {
        let selected = document.targetPageIndices
        return document.selectedPageIDs.isEmpty || !selected.contains(index) ? [index] : selected
    }

    var body: some View {
        Button("向右旋轉") { document.rotatePages(targets, by: 90) }
        Button("向左旋轉") { document.rotatePages(targets, by: -90) }
        Divider()
        Button("在後方插入空白頁") { document.insertBlankPage(after: index) }
        Button("複製頁面") { document.duplicatePages(targets) }
        Button("擷取為新 PDF…") { document.extractPages(targets) }
        Button("匯出為圖片…") { Workspace.shared.activeSheet = .exportImages }
        Divider()
        Button("刪除頁面", role: .destructive) { document.deletePages(targets) }
    }
}

// MARK: - 書籤

private struct OutlineNode: Identifiable {
    let outline: PDFOutline
    let children: [OutlineNode]?

    var id: ObjectIdentifier { ObjectIdentifier(outline) }

    init(_ outline: PDFOutline) {
        self.outline = outline
        let nodes = (0..<outline.numberOfChildren).compactMap { outline.child(at: $0) }.map(OutlineNode.init)
        children = nodes.isEmpty ? nil : nodes
    }
}

private struct OutlineSidebar: View {
    @ObservedObject var document: EditorDocument

    var body: some View {
        let _ = document.revision
        let nodes = document.pdf.outlineRoot.map { OutlineNode($0).children ?? [] } ?? []
        VStack(spacing: 0) {
            if nodes.isEmpty {
                EmptyState(symbol: "bookmark", text: "這份文件沒有書籤")
            } else {
                List(nodes, children: \.children) { node in
                    Text(node.outline.label ?? "（未命名）")
                        .lineLimit(2)
                        .contentShape(Rectangle())
                        .onTapGesture { document.go(to: node.outline) }
                        .contextMenu {
                            Button("重新命名…") { document.renameBookmark(node.outline) }
                            Button("刪除", role: .destructive) { document.removeBookmark(node.outline) }
                        }
                }
                .listStyle(.sidebar)
            }
        }
        .safeAreaInset(edge: .bottom) {
            HStack {
                Button { document.addBookmark() } label: { Label("為目前頁面新增書籤", systemImage: "bookmark") }
                Spacer()
            }
            .buttonStyle(.borderless)
            .padding(8)
            .background(.bar)
        }
    }
}

// MARK: - 註解

private struct AnnotationSidebar: View {
    @ObservedObject var document: EditorDocument

    var body: some View {
        let _ = document.revision
        let entries = document.allAnnotations
        if entries.isEmpty {
            EmptyState(symbol: "text.bubble", text: "尚無註解")
        } else {
            List {
                ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                    let index = document.pdf.index(for: entry.page)
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: symbol(for: entry.annotation))
                            .foregroundStyle(Color(nsColor: entry.annotation.color == .clear ? .labelColor : entry.annotation.color))
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(typeName(entry.annotation)).font(.caption.bold())
                            if let contents = entry.annotation.contents, !contents.isEmpty {
                                Text(contents).font(.caption).lineLimit(3)
                            }
                            Text("第 \(index + 1) 頁").font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        Button {
                            document.removeAnnotation(entry.annotation, from: entry.page)
                        } label: {
                            Image(systemName: "trash")
                        }
                        .buttonStyle(.borderless)
                        .help("刪除註解")
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { document.go(to: entry.annotation, on: entry.page) }
                }
            }
            .listStyle(.sidebar)
        }
    }

    private func typeName(_ annotation: PDFAnnotation) -> String {
        switch annotation {
        case let image as ImageStampAnnotation: return image.isSignature ? "簽名" : "圖片"
        case is WatermarkAnnotation: return "浮水印"
        case is TextStampAnnotation: return "頁碼／頁首頁尾"
        case is RedactionMarkAnnotation: return "待套用遮蓋"
        default: break
        }
        switch annotation.subtype {
        case .highlight: return "螢光筆"
        case .underline: return "底線"
        case .strikeOut: return "刪除線"
        case .text: return "便利貼"
        case .freeText: return "文字"
        case .ink: return "手繪"
        case .square: return annotation.contents == "白底遮蓋" ? "白底遮蓋" : "矩形"
        case .circle: return "橢圓"
        case .line: return annotation.endLineStyle == .none ? "直線" : "箭頭"
        case .stamp: return "圖章"
        default: return annotation.type ?? "註解"
        }
    }

    private func symbol(for annotation: PDFAnnotation) -> String {
        switch annotation.subtype {
        case .highlight: return "highlighter"
        case .underline: return "underline"
        case .strikeOut: return "strikethrough"
        case .text: return "note.text"
        case .freeText: return "character.textbox"
        case .ink: return "pencil.tip"
        case .square: return "rectangle"
        case .circle: return "circle"
        case .line: return "line.diagonal"
        case .stamp: return annotation is ImageStampAnnotation ? "photo" : "seal"
        default: return "text.bubble"
        }
    }
}

// MARK: - 搜尋

private struct SearchSidebar: View {
    @ObservedObject var document: EditorDocument
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                TextField("搜尋文件內容", text: $document.searchQuery)
                    .textFieldStyle(.roundedBorder)
                    .focused($focused)
                    .onSubmit { document.search() }
                if !document.searchQuery.isEmpty {
                    Button { document.clearSearch() } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.borderless)
                }
            }
            .padding(8)

            if !document.searchResults.isEmpty {
                HStack {
                    Text("找到 \(document.searchResults.count) 筆")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button { document.nextSearchResult(-1) } label: { Image(systemName: "chevron.up") }
                    Button { document.nextSearchResult(1) } label: { Image(systemName: "chevron.down") }
                }
                .buttonStyle(.borderless)
                .padding(.horizontal, 8)
            }

            List {
                ForEach(Array(document.searchResults.enumerated()), id: \.offset) { offset, selection in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(pageLabel(selection)).font(.caption2).foregroundStyle(.secondary)
                        Text(context(for: selection)).font(.caption).lineLimit(3)
                    }
                    .padding(.vertical, 2)
                    .contentShape(Rectangle())
                    .listRowBackground(offset == document.currentSearchIndex ? Color.accentColor.opacity(0.15) : Color.clear)
                    .onTapGesture {
                        document.currentSearchIndex = offset
                        document.show(selection)
                    }
                }
            }
            .listStyle(.sidebar)
            .overlay {
                if document.searchResults.isEmpty, !document.searchQuery.isEmpty {
                    Text("按 Return 開始搜尋").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .onAppear { focused = true }
    }

    private func pageLabel(_ selection: PDFSelection) -> String {
        guard let page = selection.pages.first else { return "" }
        return "第 \(document.pdf.index(for: page) + 1) 頁"
    }

    private func context(for selection: PDFSelection) -> String {
        guard let extended = selection.copy() as? PDFSelection else { return selection.string ?? "" }
        extended.extend(atStart: 20)
        extended.extend(atEnd: 30)
        return (extended.string ?? "").replacingOccurrences(of: "\n", with: " ")
    }
}

private struct EmptyState: View {
    let symbol: String
    let text: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).font(.largeTitle).foregroundStyle(.tertiary)
            Text(text).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
