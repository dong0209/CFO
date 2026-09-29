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

    func testFindsInstalledFontInCollection() async throws {
        let request = FontRequest(originalName: "Helvetica-Bold", family: "Helvetica", weight: 700, italic: false,
                                  system: [.init(family: "Helvetica-Bold", exact: true), .init(family: "Helvetica", exact: true)], downloads: [])
        let resolved = try await XCTUnwrap(FontResolver(cacheDirectory: FileManager.default.temporaryDirectory).resolve(request))
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
        let font = try await XCTUnwrap(FontResolver.shared.resolve(helvetica))
        let edited = try await bridge.replacingTextLine(in: original, password: nil, page: 0, line: line.index, with: "Hello 你好", font: font)
        XCTAssertTrue(["supplied", "mixed"].contains(edited.fontSource), edited.fontSource)
        let text = try XCTUnwrap(PDFDocument(data: edited.data)?.page(at: 0)?.string)
        XCTAssertTrue(text.contains("Hello"), text)
        XCTAssertTrue(text.contains("你好"), text)
    }
}
