import AppKit
import PDFEditorCore
import PDFKit
import SwiftUI

/// 一份開啟中的 PDF：持有 PDFDocument、檔案位置、未存檔狀態與復原紀錄。
@MainActor
final class EditorDocument: ObservableObject, Identifiable {
    let id = UUID()
    @Published private(set) var pdf: PDFDocument
    let undoManager = UndoManager()

    @Published var fileURL: URL?
    @Published private(set) var isDirty = false
    /// 內容變動時遞增，讓縮圖、書籤與註解清單重新整理。
    @Published private(set) var revision = 0
    @Published var currentPageIndex = 0
    @Published var selectedPageIDs: Set<ObjectIdentifier> = []
    @Published var searchQuery = ""
    @Published private(set) var searchResults: [PDFSelection] = []
    @Published var currentSearchIndex = 0
    /// 存檔時要套用的密碼；nil 代表不加密。
    @Published var security: SecurityOptions?

    weak var pdfView: EditorPDFView?
    /// 最後點選的註解，可用 Delete 鍵刪除。
    weak var selectedAnnotation: PDFAnnotation?

    init(pdf: PDFDocument, fileURL: URL?, security: SecurityOptions? = nil) {
        self.pdf = pdf
        self.fileURL = fileURL
        self.security = security
        undoManager.levelsOfUndo = 100
    }

    var displayName: String { fileURL?.lastPathComponent ?? "未命名.pdf" }
    var baseName: String { fileURL?.deletingPathExtension().lastPathComponent ?? "未命名" }
    var pageCount: Int { pdf.pageCount }
    var pages: [PDFPage] { PageOperations.pages(of: pdf) }
    var currentPage: PDFPage? { pdfView?.currentPage ?? pdf.page(at: currentPageIndex) }

    /// 頁面操作的對象：縮圖列有選取就用選取的頁面，否則用目前頁面。
    var targetPageIndices: [Int] {
        let selected = pages.enumerated()
            .filter { selectedPageIDs.contains(ObjectIdentifier($0.element)) }
            .map(\.offset)
        if !selected.isEmpty { return selected }
        return currentPage.map { [pdf.index(for: $0)] } ?? []
    }

    func markChanged() {
        isDirty = true
        revision += 1
    }

    private func refresh(_ page: PDFPage?) {
        if let page { pdfView?.annotationsChanged(on: page) }
        pdfView?.needsDisplay = true
        pdfView?.layoutDocumentView()
    }

    private func registerUndo(_ name: String, _ action: @escaping @MainActor (EditorDocument) -> Void) {
        undoManager.registerUndo(withTarget: self) { document in
            MainActor.assumeIsolated { action(document) }
        }
        undoManager.setActionName(name)
    }

    // MARK: - 註解

    func addAnnotation(_ annotation: PDFAnnotation, to page: PDFPage, actionName: String = "新增註解") {
        page.addAnnotation(annotation)
        registerUndo(actionName) { $0.removeAnnotation(annotation, from: page, actionName: actionName) }
        refresh(page)
        markChanged()
    }

    func removeAnnotation(_ annotation: PDFAnnotation, from page: PDFPage, actionName: String = "刪除註解") {
        page.removeAnnotation(annotation)
        if selectedAnnotation === annotation { selectedAnnotation = nil }
        registerUndo(actionName) { $0.addAnnotation(annotation, to: page, actionName: actionName) }
        refresh(page)
        markChanged()
    }

    func setBounds(_ bounds: CGRect, of annotation: PDFAnnotation, previous: CGRect) {
        annotation.bounds = bounds
        registerUndo("移動註解") { $0.setBounds(previous, of: annotation, previous: bounds) }
        refresh(annotation.page)
        markChanged()
    }

    func setContents(_ contents: String, of annotation: PDFAnnotation) {
        let previous = annotation.contents ?? ""
        let previousBounds = annotation.bounds
        annotation.contents = contents
        registerUndo("編輯文字") { document in
            document.setContents(previous, of: annotation)
            annotation.bounds = previousBounds
        }
        refresh(annotation.page)
        markChanged()
    }

    func deleteSelectedAnnotation() {
        guard let annotation = selectedAnnotation, let page = annotation.page else { return }
        removeAnnotation(annotation, from: page)
    }

    var allAnnotations: [(page: PDFPage, annotation: PDFAnnotation)] {
        pages.flatMap { page in
            page.annotations.filter(Self.isUserAnnotation).map { (page, $0) }
        }
    }

    static func isUserAnnotation(_ annotation: PDFAnnotation) -> Bool {
        let hidden: [PDFAnnotationSubtype] = [.widget, .link, .popup]
        return !hidden.contains(annotation.subtype)
    }

    func addMarkup(for selection: PDFSelection, tool: Tool, color: NSColor) {
        let subtype: PDFAnnotationSubtype
        switch tool {
        case .underline: subtype = .underline
        case .strikeout: subtype = .strikeOut
        default: subtype = .highlight
        }
        for line in selection.selectionsByLine() {
            for page in line.pages {
                let bounds = line.bounds(for: page)
                guard bounds.width > 0.5, bounds.height > 0.5 else { continue }
                let annotation = PDFAnnotation(bounds: bounds, forType: subtype, withProperties: nil)
                annotation.color = subtype == .highlight ? color.withAlphaComponent(0.5) : color
                annotation.quadrilateralPoints = [
                    NSValue(point: NSPoint(x: 0, y: bounds.height)),
                    NSValue(point: NSPoint(x: bounds.width, y: bounds.height)),
                    NSValue(point: NSPoint(x: 0, y: 0)),
                    NSValue(point: NSPoint(x: bounds.width, y: 0)),
                ]
                annotation.contents = line.string
                addAnnotation(annotation, to: page, actionName: tool.title)
            }
        }
    }

    func addNote(at point: CGPoint, on page: PDFPage, color: NSColor) {
        guard let text = Panels.promptText(title: "新增便利貼", message: "輸入備註內容：", multiline: true) else { return }
        let annotation = PDFAnnotation(bounds: CGRect(x: point.x - 10, y: point.y - 10, width: 20, height: 20), forType: .text, withProperties: nil)
        annotation.contents = text
        annotation.color = color
        annotation.iconType = .note
        addAnnotation(annotation, to: page, actionName: "便利貼")
    }

    /// 新增文字方塊（左上角對齊點選位置）。
    func addTextBox(_ text: String, font: NSFont, color: NSColor, at topLeft: CGPoint, on page: PDFPage) {
        guard !text.isEmpty else { return }
        addAnnotation(FreeTextStyle.make(text: text, font: font, color: color, topLeft: topLeft), to: page, actionName: "文字方塊")
    }

    /// 修改文字方塊的內容、字型與顏色（可復原）。
    func restyleTextBox(_ annotation: PDFAnnotation, text: String, font: NSFont, color: NSColor) {
        let previous = (text: annotation.contents ?? "", font: annotation.font ?? font, color: annotation.fontColor ?? .black, bounds: annotation.bounds)
        FreeTextStyle.apply(text: text, font: font, color: color, to: annotation)
        registerUndo("編輯文字") { document in
            document.restyleTextBox(annotation, text: previous.text, font: previous.font, color: previous.color)
            annotation.bounds = previous.bounds
        }
        refresh(annotation.page)
        markChanged()
    }

    // MARK: - 直接編輯原有文字

    private var isEditingText = false

    /// 點選頁面上的文字：以文字編輯引擎找出該行，並在原位顯示編輯框。
    func beginTextEdit(at point: CGPoint, on page: PDFPage) {
        guard !isEditingText else {
            pdfView?.endInlineEditing()
            return
        }
        let pageIndex = pdf.index(for: page)
        guard pageIndex != NSNotFound else { return }
        // 圖片、簽名、浮水印等自訂註解無法經由 PDF 資料保留，先固定到頁面中
        bakeCustomAnnotations()
        guard let data = pdf.dataRepresentation() else { return }
        isEditingText = true
        let password = security?.userPassword
        Task { @MainActor in
            do {
                guard let (line, request) = try await PDFEngineBridge.shared.textLineWithFont(in: data, password: password, page: pageIndex, at: point),
                      let currentPage = pdf.page(at: pageIndex) else {
                    isEditingText = false
                    NSSound.beep()
                    return
                }
                // 編輯框先顯示，背景尋找或下載原字型（或使用者自選的字型），找到後以該字型預覽
                pdfView?.showInlineEditor(for: line, request: request, on: currentPage) { [weak self] result in
                    guard let self else { return }
                    self.isEditingText = false
                    guard let result else { return }
                    self.commitTextEdit(data: data, password: password, pageIndex: pageIndex, line: line, result: result)
                }
            } catch {
                isEditingText = false
                Panels.showError(error, title: "無法編輯文字")
            }
        }
    }

    static let ocrLanguageKey = "OCRLanguage"

    /// 框選範圍重新辨識：以 Vision 辨識範圍內的文字，取代範圍內原本的 OCR 文字，並直接開啟編輯框。
    /// 取消編輯時不會留下任何變更。
    func beginRegionEdit(_ rect: CGRect, on page: PDFPage) {
        guard !isEditingText, rect.width > 4, rect.height > 4 else { return }
        let pageIndex = pdf.index(for: page)
        guard pageIndex != NSNotFound else { return }
        bakeCustomAnnotations()
        guard let data = pdf.dataRepresentation(), let currentPage = pdf.page(at: pageIndex) else { return }
        isEditingText = true
        let password = security?.userPassword
        let language = OCRService.Language(rawValue: UserDefaults.standard.string(forKey: Self.ocrLanguageKey) ?? "") ?? .traditionalChinese
        let languages = language.visionLanguages
        let workspace = Workspace.shared
        workspace.beginProgress("正在辨識框選的範圍…", total: 1)
        Task { @MainActor in
            do {
                // 只辨識框選的小範圍，速度很快，直接在主執行緒處理（PDFPage 不可跨執行緒使用）
                let recognized = try OCRService.recognizeRegion(of: currentPage, rect: rect, languages: languages)
                let prepared = try await PDFEngineBridge.shared.preparingOCRRegion(
                    in: data, password: password, page: pageIndex, rect: rect, lines: recognized
                )
                workspace.endProgress()
                pdfView?.showInlineEditor(for: prepared.line, request: prepared.request, on: currentPage) { [weak self] result in
                    guard let self else { return }
                    self.isEditingText = false
                    guard let result else { return }
                    self.commitTextEdit(data: prepared.data, password: password, pageIndex: pageIndex, line: prepared.line, result: result)
                }
            } catch {
                workspace.endProgress()
                isEditingText = false
                Panels.showError(error, title: "無法重新辨識這個範圍")
            }
        }
    }

    private func commitTextEdit(data: Data, password: String?, pageIndex: Int, line: EditableTextLine, result: InlineEditResult) {
        let settings = result.settings
        let colorChanged = !Self.sameColor(settings.color, line.nsColor)
        let styleChanged = abs(settings.size - line.fontSize) > 0.01 || colorChanged || settings.bold != line.isBold || settings.italic != line.isItalic
        guard result.text != line.text || styleChanged || settings.choice != .auto else { return }
        Task { @MainActor in
            do {
                let resolved = await result.font.value
                let fallback = await FontResolver.shared.resolveFallback(for: resolved.request, text: result.text)
                var options = TextEditOptions(font: resolved.font, fallbackFont: fallback, forceFont: settings.choice != .auto)
                if abs(settings.size - line.fontSize) > 0.01 { options.size = settings.size }
                if colorChanged || line.isOCR { options.color = Self.srgbComponents(settings.color) }
                if settings.bold != line.isBold { options.bold = settings.bold }
                if settings.italic != line.isItalic { options.italic = settings.italic }
                let edited = try await PDFEngineBridge.shared.replacingTextLine(in: data, password: password, page: pageIndex, line: line.index, with: result.text, options: options)
                guard let document = PDFDocument(data: edited.data) else { throw PDFEngineError.invalidResponse("PDF") }
                replaceDocument(with: document, actionName: "編輯文字")
            } catch {
                Panels.showError(error, title: "無法修改文字")
            }
        }
    }

    private static func srgbComponents(_ color: NSColor) -> [CGFloat] {
        let rgb = color.usingColorSpace(.sRGB) ?? .black
        return [rgb.redComponent, rgb.greenComponent, rgb.blueComponent]
    }

    private static func sameColor(_ a: NSColor, _ b: NSColor) -> Bool {
        zip(srgbComponents(a), srgbComponents(b)).allSatisfy { abs($0 - $1) < 0.01 }
    }

    /// 以新的 PDFDocument 取代目前內容（保留閱讀位置，可復原）。
    func replaceDocument(with document: PDFDocument, actionName: String) {
        let previous = pdf
        let destination = pdfView?.currentDestination
        let pageIndex = destination?.page.map { previous.index(for: $0) } ?? currentPageIndex
        pdf = document
        selectedPageIDs = []
        selectedAnnotation = nil
        searchResults = []
        pdfView?.document = document
        if let page = document.page(at: max(0, min(pageIndex, document.pageCount - 1))) {
            pdfView?.go(to: PDFDestination(page: page, at: destination?.point ?? CGPoint(x: 0, y: page.bounds(for: .cropBox).maxY)))
        }
        registerUndo(actionName) { $0.replaceDocument(with: previous, actionName: actionName) }
        markChanged()
    }

    /// 雙擊註解：文字方塊開啟文字樣式對話框，便利貼則直接編輯內容。
    func editText(of annotation: PDFAnnotation) {
        if annotation.isType(.freeText), let page = annotation.page {
            Workspace.shared.showTextBox(TextBoxRequest(page: page, point: nil, annotation: annotation))
            return
        }
        guard let text = Panels.promptText(title: "編輯備註", initial: annotation.contents ?? "", multiline: true) else { return }
        setContents(text, of: annotation)
    }

    func placeImage(_ image: CGImage, at point: CGPoint, on page: PDFPage, isSignature: Bool) {
        let targetWidth: CGFloat = isSignature ? 160 : 220
        let aspect = CGFloat(image.height) / CGFloat(max(image.width, 1))
        var size = CGSize(width: targetWidth, height: targetWidth * aspect)
        let pageBounds = page.bounds(for: .cropBox)
        if size.height > pageBounds.height * 0.8 {
            size = CGSize(width: pageBounds.height * 0.8 / aspect, height: pageBounds.height * 0.8)
        }
        let bounds = CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height)
        addAnnotation(ImageStampAnnotation(image: image, bounds: bounds, isSignature: isSignature), to: page, actionName: isSignature ? "簽名" : "插入圖片")
    }

    // MARK: - 浮水印、頁碼

    func addWatermark(text: String, fontSize: CGFloat, color: NSColor, opacity: CGFloat, angle: CGFloat, pageIndices: [Int]) {
        for index in pageIndices {
            guard let page = pdf.page(at: index) else { continue }
            let annotation = WatermarkAnnotation(pageBounds: page.bounds(for: .cropBox), text: text, fontSize: fontSize, color: color, opacity: opacity, angle: angle)
            addAnnotation(annotation, to: page, actionName: "浮水印")
        }
    }

    func addPageNumbers(template: String, startAt: Int, position: StampPosition, fontSize: CGFloat, color: NSColor, margin: CGFloat, pageIndices: [Int]) {
        let total = pdf.pageCount + startAt - 1
        for index in pageIndices {
            guard let page = pdf.page(at: index) else { continue }
            let text = PageNumberFormat.render(template, page: index + startAt, total: total)
            let annotation = TextStampAnnotation(pageBounds: page.bounds(for: .cropBox), text: text, fontSize: fontSize, color: color, position: position, margin: margin)
            addAnnotation(annotation, to: page, actionName: "頁碼／頁首頁尾")
        }
    }

    func removeStamps() {
        var removed = 0
        for page in pages {
            for annotation in page.annotations where annotation is WatermarkAnnotation || annotation is TextStampAnnotation {
                removeAnnotation(annotation, from: page, actionName: "移除浮水印與頁碼")
                removed += 1
            }
        }
        if removed == 0 {
            Panels.showMessage(title: "沒有可移除的項目", message: "只能移除在本程式中加入、尚未存檔的浮水印與頁碼。")
        }
    }

    // MARK: - 頁面

    /// 以新的頁面順序取代目前順序（插入、刪除、搬移都透過這裡，方便復原）。
    func applyPageOrder(_ newOrder: [PDFPage], actionName: String) {
        let oldOrder = pages
        let current = currentPage
        PageOperations.setPages(newOrder, of: pdf)
        selectedPageIDs = selectedPageIDs.intersection(Set(newOrder.map { ObjectIdentifier($0) }))
        registerUndo(actionName) { $0.applyPageOrder(oldOrder, actionName: actionName) }
        pdfView?.layoutDocumentView()
        if let current, pdf.index(for: current) != NSNotFound {
            pdfView?.go(to: current)
        }
        markChanged()
    }

    func rotatePages(_ indices: [Int], by degrees: Int) {
        let targets = indices.compactMap { pdf.page(at: $0) }
        guard !targets.isEmpty else { return }
        targets.forEach { PageOperations.rotate($0, by: degrees) }
        registerUndo(degrees > 0 ? "向右旋轉" : "向左旋轉") { document in
            document.rotatePages(targets.map { document.pdf.index(for: $0) }, by: -degrees)
        }
        pdfView?.layoutDocumentView()
        markChanged()
    }

    func deletePages(_ indices: [Int]) {
        let remove = Set(indices)
        guard !remove.isEmpty else { return }
        guard remove.count < pdf.pageCount else {
            Panels.showMessage(title: "無法刪除", message: "文件至少需要保留一頁。")
            return
        }
        let newOrder = pages.enumerated().filter { !remove.contains($0.offset) }.map(\.element)
        selectedPageIDs = []
        applyPageOrder(newOrder, actionName: "刪除頁面")
    }

    func insertBlankPage(after index: Int?) {
        let reference = index.flatMap { pdf.page(at: $0) } ?? currentPage
        let size = reference?.bounds(for: .cropBox).size ?? PageOperations.a4Size
        var order = pages
        let insertAt = index.map { $0 + 1 } ?? order.count
        let page = PageOperations.blankPage(size: size)
        order.insert(page, at: min(insertAt, order.count))
        applyPageOrder(order, actionName: "插入空白頁")
        pdfView?.go(to: page)
    }

    func insertPages(from documents: [PDFDocument], after index: Int?) {
        let newPages = documents.flatMap { PageOperations.pages(of: $0).map(PageOperations.copy) }
        guard !newPages.isEmpty else { return }
        var order = pages
        let insertAt = min(index.map { $0 + 1 } ?? order.count, order.count)
        order.insert(contentsOf: newPages, at: insertAt)
        applyPageOrder(order, actionName: "插入頁面")
        pdfView?.go(to: newPages[0])
    }

    func movePages(from source: IndexSet, to destination: Int) {
        applyPageOrder(PageOperations.move(pages, from: source, to: destination), actionName: "搬移頁面")
    }

    func duplicatePages(_ indices: [Int]) {
        var order = pages
        for index in indices.sorted(by: >) {
            guard let page = pdf.page(at: index) else { continue }
            order.insert(PageOperations.copy(page), at: index + 1)
        }
        applyPageOrder(order, actionName: "複製頁面")
    }

    /// 套用一組頁面替換（平面化、遮蓋、OCR），並支援復原。
    func applyReplacements(_ replacements: [PageReplacement], actionName: String) {
        guard !replacements.isEmpty else { return }
        let inverses = replacements.map { $0.apply(in: pdf) }
        registerUndo(actionName) { $0.applyReplacements(Array(inverses.reversed()), actionName: actionName) }
        pdfView?.layoutDocumentView()
        markChanged()
    }

    func flattenAll() {
        let replacements = pages.compactMap(PageFlattener.flattenAll)
        if replacements.isEmpty {
            Panels.showMessage(title: "沒有需要平面化的內容", message: "文件中沒有註解或表單欄位。")
            return
        }
        applyReplacements(replacements, actionName: "平面化")
    }

    func applyRedactions() {
        let replacements = pages.compactMap { PageFlattener.applyRedactions($0) }
        if replacements.isEmpty {
            Panels.showMessage(title: "沒有待套用的遮蓋", message: "請先使用「塗黑遮蓋」工具框選要移除的區域。")
            return
        }
        guard Panels.confirm(
            title: "套用 \(replacements.count) 頁的遮蓋？",
            message: "遮蓋區域內的文字與圖形會被永久移除，受影響的頁面會轉為圖片（無法再選取文字）。",
            confirm: "套用遮蓋",
            destructive: true
        ) else { return }
        applyReplacements(replacements, actionName: "套用遮蓋")
    }

    // MARK: - 書籤

    func addBookmark() {
        guard let page = currentPage else { return }
        let index = pdf.index(for: page)
        guard let label = Panels.promptText(title: "新增書籤", message: "書籤名稱：", initial: "第 \(index + 1) 頁") , !label.isEmpty else { return }
        let root: PDFOutline
        if let existing = pdf.outlineRoot {
            root = existing
        } else {
            root = PDFOutline()
            pdf.outlineRoot = root
        }
        let item = PDFOutline()
        item.label = label
        let top = page.bounds(for: .cropBox).maxY
        item.destination = PDFDestination(page: page, at: CGPoint(x: 0, y: top))
        root.insertChild(item, at: root.numberOfChildren)
        markChanged()
    }

    func renameBookmark(_ outline: PDFOutline) {
        guard let label = Panels.promptText(title: "重新命名書籤", initial: outline.label ?? "") else { return }
        outline.label = label
        markChanged()
    }

    func removeBookmark(_ outline: PDFOutline) {
        outline.removeFromParent()
        markChanged()
    }

    func go(to outline: PDFOutline) {
        if let destination = outline.destination {
            pdfView?.go(to: destination)
        } else if let action = outline.action as? PDFActionGoTo {
            pdfView?.go(to: action.destination)
        }
    }

    // MARK: - 導覽與檢視

    func goToPage(_ index: Int) {
        guard let page = pdf.page(at: index) else { return }
        pdfView?.go(to: page)
    }

    func go(to annotation: PDFAnnotation, on page: PDFPage) {
        pdfView?.go(to: annotation.bounds.insetBy(dx: -40, dy: -40), on: page)
        selectedAnnotation = annotation
    }

    func promptGoToPage() {
        guard let text = Panels.promptText(title: "前往頁面", message: "輸入頁碼（1–\(pageCount)）："),
              let number = Int(text.trimmingCharacters(in: .whitespaces)),
              (1...pageCount).contains(number) else { return }
        goToPage(number - 1)
    }

    // MARK: - 搜尋

    func search() {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        pdf.cancelFindString()
        guard !query.isEmpty else {
            searchResults = []
            pdfView?.highlightedSelections = nil
            return
        }
        let results = pdf.findString(query, withOptions: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive])
        results.forEach { $0.color = NSColor.systemYellow.withAlphaComponent(0.6) }
        searchResults = results
        pdfView?.highlightedSelections = results
        currentSearchIndex = 0
        if let first = results.first { show(first) }
    }

    func show(_ selection: PDFSelection) {
        pdfView?.setCurrentSelection(selection, animate: true)
        pdfView?.go(to: selection)
    }

    func nextSearchResult(_ step: Int) {
        guard !searchResults.isEmpty else { return }
        currentSearchIndex = (currentSearchIndex + step + searchResults.count) % searchResults.count
        show(searchResults[currentSearchIndex])
    }

    func clearSearch() {
        searchQuery = ""
        search()
    }

    // MARK: - 存檔

    @discardableResult
    func save() -> Bool {
        guard let url = fileURL else { return saveAs() }
        return write(to: url)
    }

    @discardableResult
    func saveAs() -> Bool {
        guard let url = Panels.save(title: "另存新檔", suggestedName: displayName) else { return false }
        guard write(to: url) else { return false }
        fileURL = url
        return true
    }

    private func write(to url: URL) -> Bool {
        bakeCustomAnnotations()
        do {
            try ExportService.write(pdf, to: url, security: security)
            isDirty = false
            revision += 1
            Workspace.shared.noteRecent(url)
            return true
        } catch {
            Panels.showError(error, title: "無法儲存")
            return false
        }
    }

    /// 圖片、簽名、浮水印與頁碼沒有對應的標準 PDF 註解格式，存檔前燒進頁面內容。
    func bakeCustomAnnotations() {
        let replacements = pages.compactMap(PageFlattener.bakeCustomAnnotations)
        guard !replacements.isEmpty else { return }
        replacements.forEach { $0.apply(in: pdf) }
        // 舊頁面已被取代，先前的復原紀錄不再適用。
        undoManager.removeAllActions()
        pdfView?.layoutDocumentView()
    }

    func print() {
        guard let pdfView else { return }
        let info = NSPrintInfo.shared
        info.jobDisposition = .spool
        pdfView.print(with: info, autoRotate: true, pageScaling: .pageScaleToFit)
    }
}
