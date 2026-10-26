import AppKit
import PDFEditorCore
import PDFKit
import SwiftUI

/// 處理各種編輯工具滑鼠操作的 PDFView。
final class EditorPDFView: PDFView {
    weak var editor: EditorDocument?

    private var tools: ToolState { ToolState.shared }

    // 拖曳中的狀態
    private var dragPage: PDFPage?
    private var dragStart: CGPoint = .zero
    private var liveAnnotation: PDFAnnotation?
    private var inkPoints: [CGPoint] = []
    private var movingAnnotation: PDFAnnotation?
    private var movingOriginalBounds: CGRect = .zero

    override var acceptsFirstResponder: Bool { true }

    private func pagePoint(for event: NSEvent) -> (PDFPage, CGPoint)? {
        let viewPoint = convert(event.locationInWindow, from: nil)
        guard let page = page(for: viewPoint, nearest: true) else { return nil }
        return (page, convert(viewPoint, to: page))
    }

    /// 可用滑鼠拖曳移動的註解（不含表單欄位、連結、文字標記）。
    private func isMovable(_ annotation: PDFAnnotation) -> Bool {
        if let custom = annotation as? CustomDrawnAnnotation { return custom.isUserMovable }
        let movable: [PDFAnnotationSubtype] = [.freeText, .text, .square, .circle, .line, .ink, .stamp]
        return movable.contains(annotation.subtype)
    }

    private func isErasable(_ annotation: PDFAnnotation) -> Bool {
        EditorDocument.isUserAnnotation(annotation) && !(annotation is WatermarkAnnotation) && !(annotation is TextStampAnnotation)
    }

    /// 優先取得最上層、可編輯的註解（避免被整頁的浮水印擋住）。
    private func topAnnotation(on page: PDFPage, at point: CGPoint, where predicate: (PDFAnnotation) -> Bool) -> PDFAnnotation? {
        page.annotations.reversed().first { $0.bounds.insetBy(dx: -3, dy: -3).contains(point) && predicate($0) }
    }

    // MARK: - 滑鼠

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        guard let editor, let (page, point) = pagePoint(for: event) else {
            super.mouseDown(with: event)
            return
        }
        let tool = tools.tool
        dragPage = page
        dragStart = point

        switch tool {
        case .select:
            if let annotation = topAnnotation(on: page, at: point, where: isMovable) {
                editor.selectedAnnotation = annotation
                let isText = annotation.isType(.freeText, .text)
                if event.clickCount == 2, isText {
                    editor.editText(of: annotation)
                    return
                }
                movingAnnotation = annotation
                movingOriginalBounds = annotation.bounds
                return
            }
            editor.selectedAnnotation = nil
            super.mouseDown(with: event)

        case .editText:
            // 點一下：編輯該行；拖曳：框選範圍重新辨識（放開滑鼠時判斷）
            break

        case .highlight, .underline, .strikeout:
            super.mouseDown(with: event)

        case .note:
            editor.addNote(at: point, on: page, color: tools.nsColor)

        case .textBox:
            Workspace.shared.showTextBox(TextBoxRequest(page: page, point: point, annotation: nil))

        case .image, .signature:
            if let image = tools.pendingImage {
                editor.placeImage(image, at: point, on: page, isSignature: tool == .signature)
                tools.pendingImage = nil
                tools.select(.select)
            } else if tool == .signature {
                Workspace.shared.activeSheet = .signatures
            } else {
                chooseImageThenPlace(at: point, on: page)
            }

        case .eraser:
            if let annotation = topAnnotation(on: page, at: point, where: isErasable) {
                editor.removeAnnotation(annotation, from: page, actionName: "擦除註解")
            }

        case .ink:
            inkPoints = [point]
            let annotation = PDFAnnotation(bounds: page.bounds(for: .mediaBox), forType: .ink, withProperties: nil)
            styleStroke(annotation)
            liveAnnotation = annotation
            page.addAnnotation(annotation)

        case .rectangle, .ellipse, .line, .arrow, .whiteout, .redact:
            let annotation = makeShape(tool, from: point, to: point)
            liveAnnotation = annotation
            page.addAnnotation(annotation)
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard let page = dragPage, let (_, rawPoint) = pagePoint(for: event) else {
            super.mouseDragged(with: event)
            return
        }
        // 拖曳過程中滑到其他頁時，仍以起始頁的座標計算。
        let viewPoint = convert(event.locationInWindow, from: nil)
        let point = self.page(for: viewPoint, nearest: true) === page ? rawPoint : convert(viewPoint, to: page)

        if let annotation = movingAnnotation {
            annotation.bounds = movingOriginalBounds.offsetBy(dx: point.x - dragStart.x, dy: point.y - dragStart.y)
            annotationsChanged(on: page)
            return
        }

        let tool = tools.tool
        if tool == .editText {
            showRegionSelection(from: dragStart, to: point, on: page)
            return
        }
        guard let live = liveAnnotation else {
            super.mouseDragged(with: event)
            return
        }
        if tool == .ink {
            inkPoints.append(point)
            page.removeAnnotation(live)
            for path in live.paths ?? [] { live.remove(path) }
            live.add(inkPath(inkPoints, origin: live.bounds.origin))
            page.addAnnotation(live)
        } else if tool.isDragShape {
            page.removeAnnotation(live)
            let updated = makeShape(tool, from: dragStart, to: point)
            liveAnnotation = updated
            page.addAnnotation(updated)
        }
        annotationsChanged(on: page)
    }

    override func mouseUp(with event: NSEvent) {
        defer {
            dragPage = nil
            liveAnnotation = nil
            movingAnnotation = nil
            inkPoints = []
        }
        guard let editor, let page = dragPage else {
            super.mouseUp(with: event)
            return
        }
        let tool = tools.tool

        if let annotation = movingAnnotation {
            if annotation.bounds != movingOriginalBounds {
                editor.setBounds(annotation.bounds, of: annotation, previous: movingOriginalBounds)
            }
            return
        }

        switch tool {
        case .editText:
            regionOverlay?.removeFromSuperview()
            regionOverlay = nil
            let end = pagePoint(for: event).map { $0.0 === page ? $0.1 : convert(convert(event.locationInWindow, from: nil), to: page) } ?? dragStart
            let rect = CGRect(x: min(dragStart.x, end.x), y: min(dragStart.y, end.y), width: abs(end.x - dragStart.x), height: abs(end.y - dragStart.y))
            if hypot(rect.width, rect.height) * scaleFactor < 5 {
                editor.beginTextEdit(at: dragStart, on: page)
            } else {
                editor.beginRegionEdit(rect, on: page)
            }

        case .highlight, .underline, .strikeout:
            super.mouseUp(with: event)
            if let selection = currentSelection, !(selection.string ?? "").isEmpty {
                editor.addMarkup(for: selection, tool: tool, color: tools.nsColor)
                clearSelection()
            }

        case .ink:
            guard let live = liveAnnotation else { return }
            page.removeAnnotation(live)
            guard inkPoints.count > 1 else { return }
            let xs = inkPoints.map(\.x), ys = inkPoints.map(\.y)
            let padding = tools.lineWidth + 2
            let bounds = CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
                .insetBy(dx: -padding, dy: -padding)
            let annotation = PDFAnnotation(bounds: bounds, forType: .ink, withProperties: nil)
            styleStroke(annotation)
            annotation.add(inkPath(inkPoints, origin: bounds.origin))
            editor.addAnnotation(annotation, to: page, actionName: "手繪")

        case .rectangle, .ellipse, .line, .arrow, .whiteout, .redact:
            guard let live = liveAnnotation else { return }
            page.removeAnnotation(live)
            let end = pagePoint(for: event).map { $0.0 === page ? $0.1 : convert(convert(event.locationInWindow, from: nil), to: page) } ?? dragStart
            guard hypot(end.x - dragStart.x, end.y - dragStart.y) > 4 else { return }
            editor.addAnnotation(makeShape(tool, from: dragStart, to: end), to: page, actionName: tool.title)

        default:
            super.mouseUp(with: event)
        }
    }

    override func mouseMoved(with event: NSEvent) {
        switch tools.tool {
        case .select, .highlight, .underline, .strikeout:
            super.mouseMoved(with: event)
        case .eraser:
            NSCursor.disappearingItem.set()
        case .editText:
            NSCursor.iBeam.set()
        default:
            NSCursor.crosshair.set()
        }
    }

    override func keyDown(with event: NSEvent) {
        // Delete / Forward Delete 刪除選取的註解
        if [51, 117].contains(event.keyCode), editor?.selectedAnnotation != nil {
            editor?.deleteSelectedAnnotation()
            return
        }
        if event.keyCode == 53, tools.tool != .select {
            tools.select(.select)
            return
        }
        super.keyDown(with: event)
    }

    // MARK: - 框選範圍重新辨識

    private var regionOverlay: NSView?

    private func showRegionSelection(from start: CGPoint, to end: CGPoint, on page: PDFPage) {
        let pageRect = CGRect(x: min(start.x, end.x), y: min(start.y, end.y), width: abs(end.x - start.x), height: abs(end.y - start.y))
        let overlay = regionOverlay ?? {
            let view = NSView()
            view.wantsLayer = true
            view.layer?.borderWidth = 1.5
            view.layer?.borderColor = NSColor.controlAccentColor.cgColor
            view.layer?.backgroundColor = NSColor.controlAccentColor.withAlphaComponent(0.12).cgColor
            addSubview(view)
            regionOverlay = view
            return view
        }()
        overlay.frame = convert(pageRect, from: page)
    }

    // MARK: - 直接編輯文字

    private var inlineEditor: InlineTextField?
    private var inlineStatus: NSTextField?
    private var inlineToolbar: InlineFontToolbar?
    private var inlineObservers: [NSObjectProtocol] = []
    private var inlineSettings: InlineFontSettings?
    private var inlineAutoRequest: FontRequest?
    private var inlineFontTask: Task<(font: ResolvedFont?, request: FontRequest?), Never>?

    /// 在文字行的位置顯示編輯框與字型工具列；預設「自動」會辨識並尋找原字型，找到後以該字型預覽。
    /// 完成時回傳新文字與字型設定（取消為 nil）。
    func showInlineEditor(for line: EditableTextLine, request: FontRequest, on page: PDFPage, completion: @escaping (InlineEditResult?) -> Void) {
        endInlineEditing()
        let settings = InlineFontSettings(choice: .auto, bold: line.isBold, italic: line.isItalic, size: line.fontSize, color: line.nsColor)
        inlineSettings = settings
        inlineAutoRequest = request

        let field = InlineTextField(line: line, page: page) { [weak self] value in
            guard let self else { return }
            let finalSettings = self.inlineSettings ?? settings
            let task = self.inlineFontTask
            self.teardownInlineEditor()
            guard let value, let task else {
                completion(nil)
                return
            }
            completion(InlineEditResult(text: value, settings: finalSettings, font: task))
        }
        inlineEditor = field
        addSubview(field)

        let toolbar = InlineFontToolbar(settings: settings, autoName: line.isOCR ? "掃描影像中的文字" : request.originalName)
        toolbar.onChange = { [weak self] newSettings in
            guard let self else { return }
            let previous = self.inlineSettings
            self.inlineSettings = newSettings
            self.inlineEditor?.textColor = newSettings.color
            if previous?.choice != newSettings.choice || previous?.bold != newSettings.bold || previous?.italic != newSettings.italic {
                self.resolveInlineFont()
            }
            self.positionInlineEditor()
        }
        toolbar.onApply = { [weak self] in self?.inlineEditor?.finish(commit: true) }
        toolbar.onCancel = { [weak self] in self?.inlineEditor?.finish(commit: false) }
        inlineToolbar = toolbar
        addSubview(toolbar)

        let status = NSTextField(wrappingLabelWithString: "")
        status.font = .systemFont(ofSize: 11)
        status.drawsBackground = true
        status.backgroundColor = .windowBackgroundColor
        status.isBordered = true
        status.maximumNumberOfLines = 4
        inlineStatus = status
        addSubview(status)

        resolveInlineFont()
        positionInlineEditor()
        window?.makeFirstResponder(field)
        field.currentEditor()?.selectAll(nil)

        let center = NotificationCenter.default
        let reposition: (Notification) -> Void = { [weak self] _ in
            MainActor.assumeIsolated { self?.positionInlineEditor() }
        }
        if let clip = documentView?.enclosingScrollView?.contentView {
            clip.postsBoundsChangedNotifications = true
            inlineObservers.append(center.addObserver(forName: NSView.boundsDidChangeNotification, object: clip, queue: .main, using: reposition))
        }
        inlineObservers.append(center.addObserver(forName: .PDFViewScaleChanged, object: self, queue: .main, using: reposition))
    }

    /// 依目前的字型選擇（自動或自選）在背景尋找字型，完成後更新預覽與狀態。
    private func resolveInlineFont() {
        guard let field = inlineEditor, let settings = inlineSettings else { return }
        let autoRequest = inlineAutoRequest
        let (choice, bold, italic) = (settings.choice, settings.bold, settings.italic)
        let task = Task { await FontResolver.shared.resolve(choice: choice, bold: bold, italic: italic, autoRequest: autoRequest) }
        inlineFontTask = task
        field.previewFont = nil
        updateInlineStatus(font: nil, resolving: true)
        Task { @MainActor [weak self, weak field] in
            let resolved = await task.value
            guard let self, let field, self.inlineEditor === field, self.inlineFontTask == task else { return }
            field.previewFont = resolved.font
            self.updateInlineStatus(font: resolved.font, resolving: false)
            self.positionInlineEditor()
        }
    }

    private func updateInlineStatus(font: ResolvedFont?, resolving: Bool) {
        guard let line = inlineEditor?.line, let settings = inlineSettings else { return }
        let wanted = settings.choice.family ?? (line.isOCR ? "掃描影像中的文字" : inlineAutoRequest?.originalName ?? line.fontName)
        var lines: [String] = []
        if !line.isTextReliable {
            lines.append("⚠ 原文無法正確辨識（PDF 缺少字元對照表），請重新輸入整行文字")
        }
        if line.isOCR {
            lines.append("這一行是 OCR 辨識出的掃描文字：套用後會把影像中的原字改成背景色，再寫入新文字")
        }
        if line.hasEmbeddedFont, settings.choice == .auto {
            lines.append("原檔內嵌字型「\(line.fontName)」，字形足夠時會直接沿用")
        }
        if resolving {
            lines.append("正在尋找字型「\(wanted)」…")
        } else if let font {
            if settings.choice == .auto, !font.exact {
                lines.append("找不到「\(wanted)」，改用相近字型：\(font.name)（\(font.sourceDescription)）")
            } else {
                lines.append("字型：\(font.name)（\(font.sourceDescription)）")
            }
        } else {
            lines.append("找不到字型「\(wanted)」，將使用標準字型")
        }
        inlineStatus?.stringValue = lines.joined(separator: "\n")
        inlineStatus?.textColor = line.isTextReliable ? .labelColor : .systemRed
    }

    /// 結束編輯並套用目前輸入的內容。
    func endInlineEditing() {
        inlineEditor?.finish(commit: true)
    }

    private func teardownInlineEditor() {
        inlineObservers.forEach { NotificationCenter.default.removeObserver($0) }
        inlineObservers = []
        inlineEditor = nil
        inlineStatus?.removeFromSuperview()
        inlineStatus = nil
        inlineToolbar?.removeFromSuperview()
        inlineToolbar = nil
        inlineSettings = nil
        inlineFontTask = nil
        inlineAutoRequest = nil
    }

    private func positionInlineEditor() {
        guard let field = inlineEditor else { return }
        let settings = inlineSettings
        let rect = convert(field.line.bounds, from: field.page)
        let size = max((settings?.size ?? field.line.fontSize) * scaleFactor, 4)
        let approximate = field.line.displayFont(scale: scaleFactor)
        var font = field.previewFont?.nsFont(size: size) ?? NSFont(descriptor: approximate.fontDescriptor, size: size) ?? approximate
        if field.previewFont == nil, let settings {
            var traits: NSFontTraitMask = []
            if settings.bold { traits.insert(.boldFontMask) }
            if settings.italic { traits.insert(.italicFontMask) }
            font = NSFontManager.shared.convert(font, toNotHaveTrait: [.boldFontMask, .italicFontMask])
            if !traits.isEmpty { font = NSFontManager.shared.convert(font, toHaveTrait: traits) }
        }
        field.font = font
        let textWidth = (field.stringValue as NSString).size(withAttributes: [.font: font]).width
        let height = max(rect.height, size * 1.25)
        field.frame = CGRect(x: rect.minX - 4, y: rect.minY - 3, width: max(rect.width, textWidth) + 16, height: height + 6)

        // 工具列放在編輯框上方、狀態列放在下方（依座標系統是否翻轉決定方向；上方空間不足時工具列改放下方）
        var below = field.frame
        if let status = inlineStatus {
            let fitting = status.sizeThatFits(CGSize(width: 460, height: 200))
            let width = min(max(fitting.width, 120), 460)
            let y = isFlipped ? field.frame.maxY + 6 : field.frame.minY - fitting.height - 6
            status.frame = CGRect(x: field.frame.minX, y: y, width: width, height: fitting.height)
            below = status.frame
        }
        if let toolbar = inlineToolbar {
            let fitting = toolbar.fittingSize
            let aboveY = isFlipped ? field.frame.minY - fitting.height - 6 : field.frame.maxY + 6
            let fitsAbove = isFlipped ? aboveY >= visibleRect.minY : aboveY + fitting.height <= visibleRect.maxY
            let belowY = isFlipped ? below.maxY + 6 : below.minY - fitting.height - 6
            toolbar.frame = CGRect(x: field.frame.minX, y: fitsAbove ? aboveY : belowY, width: fitting.width, height: fitting.height)
        }
    }

    override func layout() {
        super.layout()
        positionInlineEditor()
    }

    // MARK: - 建立註解

    private func styleStroke(_ annotation: PDFAnnotation) {
        annotation.color = tools.nsColor
        let border = PDFBorder()
        border.lineWidth = tools.lineWidth
        annotation.border = border
    }

    private func inkPath(_ points: [CGPoint], origin: CGPoint) -> NSBezierPath {
        let path = NSBezierPath()
        path.lineWidth = tools.lineWidth
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        guard let first = points.first else { return path }
        path.move(to: CGPoint(x: first.x - origin.x, y: first.y - origin.y))
        for point in points.dropFirst() {
            path.line(to: CGPoint(x: point.x - origin.x, y: point.y - origin.y))
        }
        return path
    }

    private func makeShape(_ tool: Tool, from start: CGPoint, to end: CGPoint) -> PDFAnnotation {
        let rect = CGRect(x: min(start.x, end.x), y: min(start.y, end.y), width: abs(end.x - start.x), height: abs(end.y - start.y))
        switch tool {
        case .redact:
            return RedactionMarkAnnotation(bounds: rect)
        case .whiteout:
            let annotation = PDFAnnotation(bounds: rect, forType: .square, withProperties: nil)
            annotation.color = .white
            annotation.interiorColor = .white
            let border = PDFBorder()
            border.lineWidth = 0
            annotation.border = border
            annotation.contents = "白底遮蓋"
            return annotation
        case .line, .arrow:
            let padding = tools.lineWidth * 4 + 4
            let bounds = rect.insetBy(dx: -padding, dy: -padding)
            let annotation = PDFAnnotation(bounds: bounds, forType: .line, withProperties: nil)
            annotation.startPoint = CGPoint(x: start.x - bounds.minX, y: start.y - bounds.minY)
            annotation.endPoint = CGPoint(x: end.x - bounds.minX, y: end.y - bounds.minY)
            annotation.startLineStyle = .none
            annotation.endLineStyle = tool == .arrow ? .openArrow : .none
            styleStroke(annotation)
            return annotation
        default:
            let annotation = PDFAnnotation(bounds: rect, forType: tool == .ellipse ? .circle : .square, withProperties: nil)
            styleStroke(annotation)
            if tools.fillShapes {
                annotation.interiorColor = tools.nsColor.withAlphaComponent(0.3)
            }
            return annotation
        }
    }

    private func chooseImageThenPlace(at point: CGPoint, on page: PDFPage) {
        guard let url = Panels.openImages(multiple: false, title: "選擇要插入的圖片").first,
              let image = NSImage(contentsOf: url)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
        editor?.placeImage(image, at: point, on: page, isSignature: false)
        tools.select(.select)
    }
}

/// 將 EditorPDFView 包裝給 SwiftUI 使用。
struct PDFKitView: NSViewRepresentable {
    @ObservedObject var document: EditorDocument

    func makeCoordinator() -> Coordinator {
        Coordinator(document: document)
    }

    func makeNSView(context: Context) -> EditorPDFView {
        let view = EditorPDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.displaysPageBreaks = true
        view.pageShadowsEnabled = true
        view.backgroundColor = .underPageBackgroundColor
        view.document = document.pdf
        view.editor = document
        document.pdfView = view
        if let page = document.pdf.page(at: document.currentPageIndex) {
            view.go(to: page)
        }
        NotificationCenter.default.addObserver(
            context.coordinator,
            selector: #selector(Coordinator.pageChanged(_:)),
            name: .PDFViewPageChanged,
            object: view
        )
        return view
    }

    func updateNSView(_ view: EditorPDFView, context: Context) {
        if view.document !== document.pdf {
            view.document = document.pdf
        }
        view.editor = document
        document.pdfView = view
    }

    static func dismantleNSView(_ view: EditorPDFView, coordinator: Coordinator) {
        NotificationCenter.default.removeObserver(coordinator)
    }

    @MainActor
    final class Coordinator: NSObject {
        let document: EditorDocument

        init(document: EditorDocument) {
            self.document = document
        }

        @objc func pageChanged(_ notification: Notification) {
            guard let view = notification.object as? PDFView, let page = view.currentPage else { return }
            let index = document.pdf.index(for: page)
            if index != NSNotFound, index != document.currentPageIndex {
                document.currentPageIndex = index
            }
        }
    }
}

/// 直接編輯文字的結果：新文字、字型設定與尋找中的字型。
struct InlineEditResult {
    let text: String
    let settings: InlineFontSettings
    let font: Task<(font: ResolvedFont?, request: FontRequest?), Never>
}

/// 直接編輯文字時覆蓋在原文上的輸入框（僅為畫面上的編輯介面，套用後會真正改寫頁面內容）。
final class InlineTextField: NSTextField, NSTextFieldDelegate {
    let line: EditableTextLine
    let page: PDFPage
    /// 找到的原字型，用來預覽
    var previewFont: ResolvedFont?
    private var completion: ((String?) -> Void)?

    init(line: EditableTextLine, page: PDFPage, completion: @escaping (String?) -> Void) {
        self.line = line
        self.page = page
        self.completion = completion
        super.init(frame: .zero)
        stringValue = line.text
        textColor = line.nsColor
        backgroundColor = .white
        drawsBackground = true
        isBordered = true
        isBezeled = true
        bezelStyle = .squareBezel
        focusRingType = .exterior
        lineBreakMode = .byClipping
        cell?.usesSingleLineMode = true
        cell?.isScrollable = true
        delegate = self
        toolTip = "\(line.fontName) \(Int(line.fontSize.rounded())) pt"
    }

    required init?(coder: NSCoder) {
        nil
    }

    func finish(commit: Bool) {
        guard let completion else { return }
        self.completion = nil
        completion(commit ? stringValue : nil)
        DispatchQueue.main.async { [weak self] in
            self?.removeFromSuperview()
        }
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.insertNewline(_:)) {
            finish(commit: true)
            return true
        }
        if selector == #selector(NSResponder.cancelOperation(_:)) {
            finish(commit: false)
            return true
        }
        return false
    }

    func controlTextDidChange(_ notification: Notification) {
        let width = (stringValue as NSString).size(withAttributes: [.font: font as Any]).width + 16
        if width > frame.width {
            frame.size.width = width
        }
    }

    func controlTextDidEndEditing(_ notification: Notification) {
        finish(commit: true)
    }
}
