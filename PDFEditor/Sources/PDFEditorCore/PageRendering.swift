import AppKit
import PDFKit

/// 頁面的點陣化與向量重繪。
public enum PageRenderer {
    /// 保留由暫存 PDF 產生的頁面所屬的文件，避免頁面失去底層資料。
    private static var retainedDocuments: [PDFDocument] = []
    private static let retainLock = NSLock()

    /// 將頁面（依畫面方向，含旋轉）轉成點陣圖。
    public static func image(for page: PDFPage, dpi: CGFloat, box: PDFDisplayBox = .cropBox, includeAnnotations: Bool = true) -> CGImage? {
        let bounds = page.bounds(for: box)
        let rotated = page.rotation % 180 != 0
        let scale = dpi / 72
        let width = Int(((rotated ? bounds.height : bounds.width) * scale).rounded())
        let height = Int(((rotated ? bounds.width : bounds.height) * scale).rounded())
        guard width > 0, height > 0,
              let context = bitmapContext(width: width, height: height) else { return nil }

        context.setFillColor(NSColor.white.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.scaleBy(x: scale, y: scale)

        let previous = page.displaysAnnotations
        page.displaysAnnotations = includeAnnotations
        page.draw(with: box, to: context)
        page.displaysAnnotations = previous
        return context.makeImage()
    }

    /// 將頁面內容（不含旋轉、不含註解）以 mediaBox 座標點陣化，可選擇塗黑區域。
    public static func unrotatedContentImage(for page: PDFPage, dpi: CGFloat, blackout rects: [CGRect] = []) -> CGImage? {
        let mediaBox = page.bounds(for: .mediaBox)
        let scale = dpi / 72
        let width = Int((mediaBox.width * scale).rounded())
        let height = Int((mediaBox.height * scale).rounded())
        guard width > 0, height > 0,
              let context = bitmapContext(width: width, height: height) else { return nil }

        context.setFillColor(NSColor.white.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.scaleBy(x: scale, y: scale)
        context.translateBy(x: -mediaBox.minX, y: -mediaBox.minY)
        if let ref = page.pageRef {
            context.drawPDFPage(ref)
        }
        context.setFillColor(NSColor.black.cgColor)
        for rect in rects {
            context.fill(rect)
        }
        return context.makeImage()
    }

    /// 建立與原頁面相同尺寸的新 PDF 頁面，並用 `draw` 在 mediaBox 座標上繪製內容。
    public static func makePage(like page: PDFPage, draw: (CGContext) -> Void) -> PDFPage? {
        var mediaBox = page.bounds(for: .mediaBox)
        let data = NSMutableData()
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let context = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else { return nil }
        context.beginPDFPage(nil)
        draw(context)
        context.endPDFPage()
        context.closePDF()

        guard let document = PDFDocument(data: data as Data), let newPage = document.page(at: 0) else { return nil }
        retainLock.lock()
        retainedDocuments.append(document)
        retainLock.unlock()

        newPage.setBounds(page.bounds(for: .cropBox), for: .cropBox)
        newPage.rotation = page.rotation
        return newPage
    }

    /// 以向量方式重繪頁面內容與符合條件的註解（文字仍可選取、搜尋）。
    public static func vectorPage(from page: PDFPage, drawing include: (PDFAnnotation) -> Bool) -> PDFPage? {
        makePage(like: page) { context in
            if let ref = page.pageRef {
                context.drawPDFPage(ref)
            }
            for annotation in page.annotations where include(annotation) {
                context.saveGState()
                annotation.draw(with: .mediaBox, in: context)
                context.restoreGState()
            }
        }
    }

    /// 以點陣圖取代頁面內容（用於真正移除遮蓋區域底下的文字與圖形）。
    public static func rasterizedPage(from page: PDFPage, dpi: CGFloat, blackout rects: [CGRect]) -> PDFPage? {
        guard let image = unrotatedContentImage(for: page, dpi: dpi, blackout: rects) else { return nil }
        let mediaBox = page.bounds(for: .mediaBox)
        return makePage(like: page) { context in
            context.interpolationQuality = .high
            context.draw(image, in: mediaBox)
        }
    }

    private static func bitmapContext(width: Int, height: Int) -> CGContext? {
        CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
    }
}

/// 頁面替換的結果：舊頁、新頁，以及從舊頁搬到新頁的註解。
public struct PageReplacement {
    public let oldPage: PDFPage
    public let newPage: PDFPage
    public let movedAnnotations: [PDFAnnotation]

    public init(oldPage: PDFPage, newPage: PDFPage, movedAnnotations: [PDFAnnotation]) {
        self.oldPage = oldPage
        self.newPage = newPage
        self.movedAnnotations = movedAnnotations
    }

    /// 在文件中以新頁取代舊頁，並搬移註解；回傳反向操作。
    @discardableResult
    public func apply(in document: PDFDocument) -> PageReplacement {
        let index = document.index(for: oldPage)
        for annotation in movedAnnotations {
            oldPage.removeAnnotation(annotation)
            newPage.addAnnotation(annotation)
        }
        if index != NSNotFound {
            document.removePage(at: index)
            document.insert(newPage, at: index)
        }
        return PageReplacement(oldPage: newPage, newPage: oldPage, movedAnnotations: movedAnnotations)
    }
}

/// 平面化：把註解固定到頁面內容中。
public enum PageFlattener {
    private static func isKeptAsAnnotation(_ annotation: PDFAnnotation) -> Bool {
        annotation.isType(.link)
    }

    /// 建立「平面化所有註解與表單」的頁面替換（連結保留為註解）。
    public static func flattenAll(_ page: PDFPage) -> PageReplacement? {
        let drawable = page.annotations.filter {
            !isKeptAsAnnotation($0) && !$0.isType(.popup) && !($0 is RedactionMarkAnnotation)
        }
        guard !drawable.isEmpty,
              let newPage = PageRenderer.vectorPage(from: page, drawing: { drawable.contains($0) }) else { return nil }
        let kept = page.annotations.filter { !drawable.contains($0) && !$0.isType(.popup) }
        return PageReplacement(oldPage: page, newPage: newPage, movedAnnotations: kept)
    }

    /// 只把自訂繪圖註解（圖片、簽名、浮水印、頁碼）燒進頁面，其餘註解保持可編輯。
    public static func bakeCustomAnnotations(_ page: PDFPage) -> PageReplacement? {
        let custom = page.annotations.filter { $0 is CustomDrawnAnnotation }
        guard !custom.isEmpty,
              let newPage = PageRenderer.vectorPage(from: page, drawing: { $0 is CustomDrawnAnnotation }) else { return nil }
        let kept = page.annotations.filter { !($0 is CustomDrawnAnnotation) && !$0.isType(.popup) }
        return PageReplacement(oldPage: page, newPage: newPage, movedAnnotations: kept)
    }

    /// 套用頁面上的遮蓋標記：點陣化並塗黑，同時移除與遮蓋區域重疊的註解。
    public static func applyRedactions(_ page: PDFPage, dpi: CGFloat = 200) -> PageReplacement? {
        let marks = page.annotations.filter { $0 is RedactionMarkAnnotation }
        guard !marks.isEmpty else { return nil }
        let rects = marks.map(\.bounds)
        guard let newPage = PageRenderer.rasterizedPage(from: page, dpi: dpi, blackout: rects) else { return nil }
        let kept = page.annotations.filter { annotation in
            !(annotation is RedactionMarkAnnotation)
                && !annotation.isType(.popup)
                && !rects.contains(where: { $0.intersects(annotation.bounds) })
        }
        return PageReplacement(oldPage: page, newPage: newPage, movedAnnotations: kept)
    }
}
