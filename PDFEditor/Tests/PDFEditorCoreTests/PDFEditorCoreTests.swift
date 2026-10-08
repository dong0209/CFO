import AppKit
import PDFKit
import XCTest
@testable import PDFEditorCore

/// 產生含有頁碼文字的測試文件。
private func makeDocument(pages: Int, size: CGSize = PageOperations.a4Size) -> PDFDocument {
    var mediaBox = CGRect(origin: .zero, size: size)
    let data = NSMutableData()
    let consumer = CGDataConsumer(data: data as CFMutableData)!
    let context = CGContext(consumer: consumer, mediaBox: &mediaBox, nil)!
    for index in 1...pages {
        context.beginPDFPage(nil)
        let text = NSAttributedString(string: "Page \(index)", attributes: [.font: NSFont.systemFont(ofSize: 24)])
        TextDrawing.draw(text, at: CGPoint(x: 72, y: 700), in: context)
        context.endPDFPage()
    }
    context.closePDF()
    return PDFDocument(data: data as Data)!
}

private func pageTexts(_ document: PDFDocument) -> [String] {
    PageOperations.pages(of: document).map { ($0.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
}

final class PageOperationsTests: XCTestCase {
    func testParsePageRanges() {
        XCTAssertEqual(PageOperations.parsePageRanges("1-3, 5, 8-", pageCount: 10), [0...2, 4...4, 7...9])
        XCTAssertEqual(PageOperations.parsePageRanges("2，4～5", pageCount: 5), [1...1, 3...4])
        XCTAssertEqual(PageOperations.parsePageRanges("-2", pageCount: 5), [0...1])
        XCTAssertNil(PageOperations.parsePageRanges("0", pageCount: 5))
        XCTAssertNil(PageOperations.parsePageRanges("3-1", pageCount: 5))
        XCTAssertNil(PageOperations.parsePageRanges("6", pageCount: 5))
        XCTAssertNil(PageOperations.parsePageRanges("abc", pageCount: 5))
        XCTAssertNil(PageOperations.parsePageRanges("", pageCount: 5))
    }

    func testIndicesFromRanges() {
        XCTAssertEqual(PageOperations.indices(from: [3...4, 0...1, 1...2]), [0, 1, 2, 3, 4])
    }

    func testMoveMatchesListSemantics() {
        let items = ["a", "b", "c", "d", "e"]
        XCTAssertEqual(PageOperations.move(items, from: [0], to: 3), ["b", "c", "a", "d", "e"])
        XCTAssertEqual(PageOperations.move(items, from: [4], to: 0), ["e", "a", "b", "c", "d"])
        XCTAssertEqual(PageOperations.move(items, from: [1, 3], to: 5), ["a", "c", "e", "b", "d"])
    }

    func testRotationNormalization() {
        XCTAssertEqual(PageOperations.normalizedRotation(-90), 270)
        XCTAssertEqual(PageOperations.normalizedRotation(450), 90)
        let page = PageOperations.blankPage()
        PageOperations.rotate(page, by: 90)
        PageOperations.rotate(page, by: 270)
        XCTAssertEqual(page.rotation, 0)
    }

    func testBlankPageSize() {
        let page = PageOperations.blankPage(size: PageOperations.letterSize)
        XCTAssertEqual(page.bounds(for: .mediaBox).size, PageOperations.letterSize)
    }

    func testSetPagesReorders() {
        let document = makeDocument(pages: 3)
        let pages = PageOperations.pages(of: document)
        PageOperations.setPages([pages[2], pages[0], pages[1]], of: document)
        XCTAssertEqual(pageTexts(document), ["Page 3", "Page 1", "Page 2"])
    }

    func testExtractMergeAndSplit() {
        let document = makeDocument(pages: 5)
        let extracted = PageOperations.extract(pageIndices: [1, 3], from: document)
        XCTAssertEqual(pageTexts(extracted), ["Page 2", "Page 4"])
        XCTAssertEqual(document.pageCount, 5, "擷取不應改變原文件")

        let merged = PageOperations.merge([document, extracted])
        XCTAssertEqual(merged.pageCount, 7)
        XCTAssertEqual(pageTexts(merged).last, "Page 4")

        let parts = PageOperations.split(document, every: 2)
        XCTAssertEqual(parts.map(\.pageCount), [2, 2, 1])

        let ranged = PageOperations.split(document, ranges: [0...0, 2...4])
        XCTAssertEqual(ranged.map(\.pageCount), [1, 3])
    }

    func testPageNumberFormat() {
        XCTAssertEqual(PageNumberFormat.render("第 {n} 頁，共 {total} 頁", page: 3, total: 12), "第 3 頁，共 12 頁")
    }

    func testStampPositions() {
        let bounds = CGRect(x: 0, y: 0, width: 600, height: 800)
        let size = CGSize(width: 100, height: 20)
        XCTAssertEqual(StampPosition.bottomCenter.origin(for: size, in: bounds, margin: 30), CGPoint(x: 250, y: 30))
        XCTAssertEqual(StampPosition.topRight.origin(for: size, in: bounds, margin: 30), CGPoint(x: 470, y: 750))
    }
}

final class RenderingTests: XCTestCase {
    func testImageRenderingHonorsRotation() throws {
        let document = makeDocument(pages: 1, size: CGSize(width: 600, height: 800))
        let page = try XCTUnwrap(document.page(at: 0))
        page.rotation = 90
        let image = try XCTUnwrap(PageRenderer.image(for: page, dpi: 144))
        XCTAssertEqual(image.width, 1600)
        XCTAssertEqual(image.height, 1200)
    }

    func testBakeCustomAnnotationsKeepsTextAndOtherAnnotations() throws {
        let document = makeDocument(pages: 1)
        let page = try XCTUnwrap(document.page(at: 0))
        let note = PDFAnnotation(bounds: CGRect(x: 10, y: 10, width: 20, height: 20), forType: .text, withProperties: nil)
        note.contents = "備註"
        page.addAnnotation(note)
        page.addAnnotation(WatermarkAnnotation(pageBounds: page.bounds(for: .mediaBox), text: "機密", fontSize: 60, color: .red, opacity: 0.3, angle: 45))

        let replacement = try XCTUnwrap(PageFlattener.bakeCustomAnnotations(page))
        let undo = replacement.apply(in: document)

        let newPage = try XCTUnwrap(document.page(at: 0))
        XCTAssertTrue(newPage === replacement.newPage)
        XCTAssertTrue(newPage.annotations.contains(note))
        XCTAssertFalse(newPage.annotations.contains(where: { $0 is WatermarkAnnotation }))
        XCTAssertTrue((newPage.string ?? "").contains("Page 1"), "向量重繪後文字應仍可搜尋")

        undo.apply(in: document)
        XCTAssertTrue(document.page(at: 0) === page)
        XCTAssertTrue(page.annotations.contains(note))
    }

    func testRedactionRemovesText() throws {
        let document = makeDocument(pages: 1)
        let page = try XCTUnwrap(document.page(at: 0))
        page.addAnnotation(RedactionMarkAnnotation(bounds: CGRect(x: 60, y: 690, width: 200, height: 40)))
        let replacement = try XCTUnwrap(PageFlattener.applyRedactions(page, dpi: 72))
        replacement.apply(in: document)
        let newPage = try XCTUnwrap(document.page(at: 0))
        XCTAssertFalse((newPage.string ?? "").contains("Page"))
        XCTAssertFalse(newPage.annotations.contains(where: { $0 is RedactionMarkAnnotation }))
    }
}

final class ExportTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testEncryptAndRemovePassword() throws {
        let document = makeDocument(pages: 2)
        let url = folder.appendingPathComponent("secret.pdf")
        try ExportService.write(document, to: url, security: SecurityOptions(userPassword: "1234"))

        let encrypted = try XCTUnwrap(PDFDocument(url: url))
        XCTAssertTrue(encrypted.isLocked)
        XCTAssertFalse(encrypted.unlock(withPassword: "wrong"))
        XCTAssertTrue(encrypted.unlock(withPassword: "1234"))

        let plainURL = folder.appendingPathComponent("plain.pdf")
        try ExportService.write(encrypted, to: plainURL, security: nil)
        let plain = try XCTUnwrap(PDFDocument(url: plainURL))
        XCTAssertFalse(plain.isEncrypted)
        XCTAssertEqual(pageTexts(plain), ["Page 1", "Page 2"])
    }

    func testOverwriteExistingFile() throws {
        let url = folder.appendingPathComponent("doc.pdf")
        try ExportService.write(makeDocument(pages: 1), to: url, security: nil)
        let opened = try XCTUnwrap(PDFDocument(url: url))
        opened.insert(PageOperations.blankPage(), at: 1)
        try ExportService.write(opened, to: url, security: nil)
        XCTAssertEqual(PDFDocument(url: url)?.pageCount, 2)
    }

    func testExportImagesAndText() throws {
        let document = makeDocument(pages: 3)
        let files = try ExportService.exportImages(from: document, pageIndices: [0, 2], to: folder, baseName: "doc", format: .png, dpi: 72)
        XCTAssertEqual(files.map(\.lastPathComponent), ["doc-1.png", "doc-3.png"])
        XCTAssertNotNil(NSImage(contentsOf: files[0]))

        let back = ExportService.document(fromImagesAt: files)
        XCTAssertEqual(back.pageCount, 2)

        XCTAssertTrue(ExportService.plainText(of: document).contains("Page 3"))
    }

    func testCompressedWrite() throws {
        let url = folder.appendingPathComponent("small.pdf")
        try ExportService.writeCompressed(makeDocument(pages: 2), to: url)
        XCTAssertEqual(PDFDocument(url: url)?.pageCount, 2)
    }
}

final class FontTests: XCTestCase {
    func testCatalogListsInstalledFonts() {
        let (recommended, others) = FontCatalog.groupedFamilies()
        XCTAssertFalse(recommended.isEmpty, "至少應有一個常用字型")
        XCTAssertTrue(recommended.contains { $0.name == "Helvetica" } || recommended.contains { $0.name == "PingFang TC" })
        XCTAssertTrue(Set(recommended.map(\.name)).isDisjoint(with: others.map(\.name)), "常用與其他字型不應重複")
        XCTAssertFalse(FontCatalog.faces(of: "Helvetica").isEmpty)
    }

    func testFontLookupFallsBack() {
        let bold = FontCatalog.font(family: "Helvetica", face: "Helvetica-Bold", size: 20)
        XCTAssertEqual(bold.fontName, "Helvetica-Bold")
        XCTAssertEqual(bold.pointSize, 20)
        let regular = FontCatalog.font(family: "Helvetica", face: nil, size: 12)
        XCTAssertEqual(regular.familyName, "Helvetica")
        let missing = FontCatalog.font(family: "不存在的字型", face: "NoSuchFont", size: 12)
        XCTAssertEqual(missing.pointSize, 12)
    }

    func testFreeTextKeepsTopLeftAndFontAfterSave() throws {
        let document = PDFDocument()
        let page = PageOperations.blankPage()
        document.insert(page, at: 0)
        let font = FontCatalog.font(family: "Times New Roman", face: nil, size: 18)
        let annotation = FreeTextStyle.make(text: "Hello", font: font, color: .red, topLeft: CGPoint(x: 100, y: 700))
        XCTAssertEqual(annotation.bounds.maxY, 700, accuracy: 0.01)
        page.addAnnotation(annotation)

        let bigger = FontCatalog.font(family: "Helvetica", face: "Helvetica-Bold", size: 36)
        FreeTextStyle.apply(text: "Hello\n第二行", font: bigger, color: .blue, to: annotation)
        XCTAssertEqual(annotation.bounds.minX, 100, accuracy: 0.01)
        XCTAssertEqual(annotation.bounds.maxY, 700, accuracy: 0.01)
        XCTAssertGreaterThan(annotation.bounds.height, 80)

        let reopened = try XCTUnwrap(document.dataRepresentation().flatMap(PDFDocument.init(data:)))
        let saved = try XCTUnwrap(reopened.page(at: 0)?.annotations.first { $0.isType(.freeText) })
        XCTAssertEqual(saved.contents, "Hello\n第二行")
        XCTAssertEqual(saved.font?.fontName, "Helvetica-Bold")
        XCTAssertEqual(saved.font?.pointSize ?? 0, 36, accuracy: 0.5)
    }
}

/// 需要先建置引擎（PDFEditorWindows：npm run build:mac-engine），CI 會自動設定 PDFEDITOR_ENGINE_DIR。
final class TextEditEngineTests: XCTestCase {
    @MainActor
    func testReplaceTextLineThroughEngine() async throws {
        guard PDFEngineBridge.engineDirectory != nil else {
            throw XCTSkip("尚未建置文字編輯引擎")
        }
        _ = NSApplication.shared
        let original = try XCTUnwrap(makeDocument(pages: 2).dataRepresentation())
        let bridge = PDFEngineBridge.shared

        // 「Page 2」位於第 2 頁 (72, 700)，字級 24
        let line = try await bridge.textLine(in: original, password: nil, page: 1, at: CGPoint(x: 90, y: 708))
        let found = try XCTUnwrap(line)
        XCTAssertEqual(found.text, "Page 2")
        XCTAssertEqual(found.fontSize, 24, accuracy: 0.5)
        XCTAssertEqual(found.bounds.minX, 72, accuracy: 1)
        XCTAssertTrue(found.bounds.contains(CGPoint(x: 90, y: 708)))

        let missing = try await bridge.textLine(in: original, password: nil, page: 1, at: CGPoint(x: 400, y: 100))
        XCTAssertNil(missing)

        let edited = try await bridge.replacingTextLine(in: original, password: nil, page: 1, line: found.index, with: "第二章 Chapter")
        let document = try XCTUnwrap(PDFDocument(data: edited.data))
        XCTAssertEqual(document.pageCount, 2)
        let text = document.page(at: 1)?.string ?? ""
        XCTAssertTrue(text.contains("Chapter"), "新文字應寫入頁面：\(text)")
        XCTAssertFalse(text.contains("Page 2"), "原文字應被移除：\(text)")
        XCTAssertTrue((document.page(at: 0)?.string ?? "").contains("Page 1"), "其他頁面不受影響")
    }

    /// 頁面某區域（PDF 座標）中的深色像素數量。
    private func darkPixels(in page: PDFPage, rect: CGRect) -> Int {
        guard let image = PageRenderer.image(for: page, dpi: 72, includeAnnotations: false) else { return -1 }
        let width = image.width
        let height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let drawn: Bool = pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return -1 }
        let bounds = page.bounds(for: .cropBox)
        var count = 0
        for y in Int(rect.minY)..<Int(rect.maxY) {
            let row = height - 1 - (y - Int(bounds.minY))
            guard row >= 0, row < height else { continue }
            for x in Int(rect.minX)..<Int(rect.maxX) where x >= 0 && x < width {
                let i = (row * width + x) * 4
                if Int(pixels[i]) + Int(pixels[i + 1]) + Int(pixels[i + 2]) < 300 { count += 1 }
            }
        }
        return count
    }

    @MainActor
    func testEditOCRTextRemovesScannedGlyphs() async throws {
        guard PDFEngineBridge.engineDirectory != nil else {
            throw XCTSkip("尚未建置文字編輯引擎")
        }
        _ = NSApplication.shared
        // 模擬掃描檔：整頁轉成影像，再以 OCR 加上隱形文字層（與「工具 ▸ 文字辨識」相同的方式）
        let source = makeDocument(pages: 1)
        let page = try XCTUnwrap(source.page(at: 0))
        let mediaBox = page.bounds(for: .mediaBox)
        let image = try XCTUnwrap(PageRenderer.image(for: page, dpi: 144))
        let scanned = try XCTUnwrap(PageRenderer.makePage(like: page) { context in
            context.draw(image, in: mediaBox)
        })
        let lineRect = CGRect(x: 70, y: 694, width: 82, height: 28)
        let normalized = CGRect(x: lineRect.minX / mediaBox.width, y: lineRect.minY / mediaBox.height,
                                width: lineRect.width / mediaBox.width, height: lineRect.height / mediaBox.height)
        let ocrPage = try XCTUnwrap(OCRService.searchablePage(from: scanned, lines: [.init(text: "Page 1", normalizedBox: normalized)]))
        let document = PDFDocument()
        document.insert(ocrPage, at: 0)
        let data = try XCTUnwrap(document.dataRepresentation())
        let glyphArea = CGRect(x: 72, y: 697, width: 70, height: 20)
        XCTAssertGreaterThan(darkPixels(in: ocrPage, rect: glyphArea), 30, "掃描影像中應有原本的字")

        let bridge = PDFEngineBridge.shared
        let found = try await bridge.textLine(in: data, password: nil, page: 0, at: CGPoint(x: 100, y: 705))
        let line = try XCTUnwrap(found)
        XCTAssertEqual(line.text, "Page 1")
        XCTAssertTrue(line.isOCR, "應辨識為 OCR 文字")

        let edited = try await bridge.replacingTextLine(in: data, password: nil, page: 0, line: line.index, with: "")
        let editedPage = try XCTUnwrap(PDFDocument(data: edited.data)?.page(at: 0))
        XCTAssertLessThan(darkPixels(in: editedPage, rect: glyphArea), 5, "影像中的原字應被移除")
        XCTAssertFalse((editedPage.string ?? "").contains("Page 1"))
    }

    @MainActor
    func testRegionOCRCreatesEditableLine() async throws {
        guard PDFEngineBridge.engineDirectory != nil else {
            throw XCTSkip("尚未建置文字編輯引擎")
        }
        _ = NSApplication.shared
        // 掃描頁（沒有文字層），框選「Page 1」所在的範圍
        let source = makeDocument(pages: 1)
        let page = try XCTUnwrap(source.page(at: 0))
        let mediaBox = page.bounds(for: .mediaBox)
        let image = try XCTUnwrap(PageRenderer.image(for: page, dpi: 144))
        let scanned = try XCTUnwrap(PageRenderer.makePage(like: page) { context in
            context.draw(image, in: mediaBox)
        })
        let document = PDFDocument()
        document.insert(scanned, at: 0)
        let data = try XCTUnwrap(document.dataRepresentation())
        let region = CGRect(x: 60, y: 690, width: 120, height: 40)

        let recognized = try OCRService.recognizeRegion(of: scanned, rect: region, languages: ["en-US"])
        XCTAssertTrue(recognized.contains { $0.text.contains("Page") }, "Vision 應辨識出框選範圍的文字：\(recognized)")
        for line in recognized {
            XCTAssertTrue(region.insetBy(dx: -2, dy: -2).contains(line.box), "文字外框應在框選範圍內：\(line.box)")
        }

        let prepared = try await PDFEngineBridge.shared.preparingOCRRegion(in: data, password: nil, page: 0, rect: region,
                                                                            lines: [.init(text: "Page 1", box: CGRect(x: 72, y: 696, width: 70, height: 24))])
        XCTAssertEqual(prepared.line.text, "Page 1")
        XCTAssertTrue(prepared.line.isOCR)
        let edited = try await PDFEngineBridge.shared.replacingTextLine(in: prepared.data, password: nil, page: 0, line: prepared.line.index, with: "Page 9")
        let editedPage = try XCTUnwrap(PDFDocument(data: edited.data)?.page(at: 0))
        XCTAssertTrue((editedPage.string ?? "").contains("Page 9"))
    }

    @MainActor
    func testImageEditThroughEngine() async throws {
        guard PDFEngineBridge.engineDirectory != nil else {
            throw XCTSkip("尚未建置文字編輯引擎")
        }
        _ = NSApplication.shared
        let original = try XCTUnwrap(makeDocument(pages: 1).dataRepresentation())
        let bridge = PDFEngineBridge.shared
        let image = try await bridge.withDocument(original, password: nil) { id in
            try await bridge.editorImage(document: id, page: 0, dpi: 72)
        }
        XCTAssertEqual(image.width, PageOperations.a4Size.width, accuracy: 1)
        XCTAssertNotNil(NSImage(data: image.png), "應為可讀取的 PNG")

        // 只加入物件：保留原本內容，新文字可搜尋
        let objectsOnly = await ImageEditorSession.prepareEdit([
            "width": Double(image.width),
            "height": Double(image.height),
            "background": NSNull(),
            "objects": [
                ["type": "text", "x": 100.0, "y": 300.0, "w": 200.0, "h": 30.0, "rotation": 0.0, "text": "Image Edit 影像編輯", "size": 18.0,
                 "color": [0.0, 0.0, 1.0], "bold": true, "italic": false, "align": "left", "opacity": 1.0,
                 "choice": ["kind": "system", "family": "Helvetica"]] as [String: Any],
                ["type": "rect", "x": 100.0, "y": 400.0, "w": 80.0, "h": 40.0, "rotation": 15.0, "stroke": [1.0, 0.0, 0.0],
                 "fill": NSNull(), "strokeWidth": 2.0, "opacity": 1.0] as [String: Any],
            ],
        ])
        let objectsText = try XCTUnwrap(objectsOnly["objects"] as? [[String: Any]])
        XCTAssertNotNil(objectsText[0]["font"], "應找到 Helvetica 字型檔")
        XCTAssertNil(objectsText[0]["choice"])
        let edited = try await bridge.withDocument(original, password: nil) { id in
            try await bridge.applyImageEdit(document: id, page: 0, edit: objectsOnly)
            return try await bridge.save(document: id)
        }
        let editedText = try XCTUnwrap(PDFDocument(data: edited)?.page(at: 0)?.string)
        XCTAssertTrue(editedText.contains("Page 1"), editedText)
        XCTAssertTrue(editedText.contains("Image Edit"), editedText)
        XCTAssertTrue(editedText.contains("影像編輯"), editedText)

        // 修改像素並裁切：整頁換成影像，頁面大小改變
        let cropped = await ImageEditorSession.prepareEdit([
            "width": 300.0,
            "height": 200.0,
            "background": image.png.base64EncodedString(),
            "objects": [[String: Any]](),
        ])
        let croppedData = try await bridge.withDocument(original, password: nil) { id in
            try await bridge.applyImageEdit(document: id, page: 0, edit: cropped)
            return try await bridge.save(document: id)
        }
        let croppedPage = try XCTUnwrap(PDFDocument(data: croppedData)?.page(at: 0))
        XCTAssertEqual(croppedPage.bounds(for: .mediaBox).size, CGSize(width: 300, height: 200))
        XCTAssertFalse((croppedPage.string ?? "").contains("Page 1"), "像素修改後原本的文字層不應殘留")
    }

    @MainActor
    func testEncryptedDocumentNeedsPassword() async throws {
        guard PDFEngineBridge.engineDirectory != nil else {
            throw XCTSkip("尚未建置文字編輯引擎")
        }
        _ = NSApplication.shared
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appendingPathComponent("locked.pdf")
        try ExportService.write(makeDocument(pages: 1), to: url, security: SecurityOptions(userPassword: "pw"))
        let data = try Data(contentsOf: url)

        do {
            _ = try await PDFEngineBridge.shared.textLine(in: data, password: "wrong", page: 0, at: CGPoint(x: 90, y: 708))
            XCTFail("錯誤密碼應失敗")
        } catch PDFEngineError.passwordRequired {}
        let line = try await PDFEngineBridge.shared.textLine(in: data, password: "pw", page: 0, at: CGPoint(x: 90, y: 708))
        XCTAssertEqual(line?.text, "Page 1")
    }
}

final class FontResolverTests: XCTestCase {
    func testGoogleFontsURLs() {
        XCTAssertEqual(FontResolver.cssURL(family: "Noto Sans TC", weight: 700, italic: false)?.absoluteString, "https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@700")
        XCTAssertEqual(FontResolver.cssURL(family: "Roboto", weight: 400, italic: true)?.absoluteString, "https://fonts.googleapis.com/css2?family=Roboto:ital,wght@1,400")
        XCTAssertEqual(FontResolver.fontURL(fromCSS: "src: url(https://fonts.gstatic.com/s/x/a.ttf) format('truetype');")?.absoluteString, "https://fonts.gstatic.com/s/x/a.ttf")
        XCTAssertNil(FontResolver.fontURL(fromCSS: "<html>"))
    }

    func testChosenFontRequest() {
        let roboto = FontRequest.chosen(family: "Roboto", weight: 700, italic: false, downloadable: true)
        XCTAssertEqual(roboto.downloads, [.init(family: "Roboto", exact: true)])
        XCTAssertTrue(roboto.system.isEmpty)
        XCTAssertEqual(roboto.weight, 700)
        XCTAssertEqual(roboto.fallback?.downloads.first?.family, "Noto Sans TC", "英文字型需要中文備援")
        XCTAssertNil(FontRequest.chosen(family: "Noto Sans TC", weight: 400, italic: false, downloadable: true).fallback)
        XCTAssertEqual(FontRequest.chosen(family: "PingFang TC", weight: 400, italic: false, downloadable: false).system.first?.family, "PingFang TC")
        XCTAssertTrue(FontResolver.downloadableFamilies.contains("Noto Serif TC"))
    }

    func testResolvesChosenSystemFontWithStyle() async throws {
        let resolver = FontResolver(cacheDirectory: FileManager.default.temporaryDirectory)
        let result = await resolver.resolve(choice: .system("Helvetica"), bold: true, italic: false, autoRequest: nil)
        let font = try XCTUnwrap(result.font)
        XCTAssertEqual(font.source, .system)
        XCTAssertEqual(font.nsFont(size: 12)?.fontName, "Helvetica-Bold")

        let auto = FontRequest(originalName: "Helvetica", family: "Helvetica", weight: 400, italic: false, system: [.init(family: "Helvetica", exact: true)], downloads: [])
        let bolded = await resolver.resolve(choice: .auto, bold: true, italic: false, autoRequest: auto)
        XCTAssertEqual(bolded.request?.weight, 700)
        XCTAssertEqual(bolded.font?.nsFont(size: 12)?.fontName, "Helvetica-Bold")
    }

    func testFindsInstalledFontInCollection() async throws {
        let request = FontRequest(originalName: "Helvetica-Bold", family: "Helvetica", weight: 700, italic: false,
                                  system: [.init(family: "Helvetica-Bold", exact: true), .init(family: "Helvetica", exact: true)], downloads: [])
        let found = await FontResolver(cacheDirectory: FileManager.default.temporaryDirectory).resolve(request)
        let resolved = try XCTUnwrap(found)
        XCTAssertEqual(resolved.source, .system)
        XCTAssertTrue(resolved.exact)
        let font = try XCTUnwrap(resolved.nsFont(size: 20))
        XCTAssertEqual(font.fontName, "Helvetica-Bold")
    }

    func testDownloadsAndCachesGoogleFont() async throws {
        let cache = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: cache) }
        let request = FontRequest(originalName: "Roboto-Bold", family: "Roboto", weight: 700, italic: false,
                                  system: [.init(family: "RobotoNotInstalledHere", exact: true)], downloads: [.init(family: "Roboto", exact: true)])
        let resolver = FontResolver(cacheDirectory: cache)
        guard let resolved = await resolver.resolve(request) else {
            throw XCTSkip("無法連線到 Google Fonts")
        }
        XCTAssertEqual(resolved.source, .download)
        XCTAssertEqual(resolved.name, "Roboto Bold")
        XCTAssertNotNil(resolved.nsFont(size: 12))
        let cached = try FileManager.default.contentsOfDirectory(atPath: cache.path)
        XCTAssertEqual(cached, ["Roboto-700.ttf"])

        let unknown = FontRequest(originalName: "X", family: "X", weight: 400, italic: false, system: [], downloads: [.init(family: "Definitely Not A Real Font Name", exact: true)])
        let missing = await resolver.resolve(unknown)
        XCTAssertNil(missing)
    }

    @MainActor
    func testReplaceLineWithResolvedFont() async throws {
        guard PDFEngineBridge.engineDirectory != nil else {
            throw XCTSkip("尚未建置文字編輯引擎")
        }
        _ = NSApplication.shared
        let original = try XCTUnwrap(makeDocument(pages: 1).dataRepresentation())
        let bridge = PDFEngineBridge.shared
        let found = try await bridge.textLineWithFont(in: original, password: nil, page: 0, at: CGPoint(x: 90, y: 708))
        let (line, request) = try XCTUnwrap(found)
        XCTAssertEqual(line.text, "Page 1")
        XCTAssertFalse(request.system.isEmpty)

        let helvetica = FontRequest(originalName: "Helvetica", family: "Helvetica", weight: 400, italic: false, system: [.init(family: "Helvetica", exact: true)], downloads: [])
        let resolvedFont = await FontResolver.shared.resolve(helvetica)
        let font = try XCTUnwrap(resolvedFont)
        let edited = try await bridge.replacingTextLine(in: original, password: nil, page: 0, line: line.index, with: "Hello 你好", options: TextEditOptions(font: font))
        XCTAssertTrue(["supplied", "mixed"].contains(edited.fontSource), edited.fontSource)
        let text = try XCTUnwrap(PDFDocument(data: edited.data)?.page(at: 0)?.string)
        XCTAssertTrue(text.contains("Hello"), text)
        XCTAssertTrue(text.contains("你好"), text)
    }
}
