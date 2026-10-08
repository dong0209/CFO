import CoreText
import PDFKit
import Vision

/// 使用 macOS 內建 Vision 進行文字辨識，並在頁面上加入隱形文字層，讓掃描檔可搜尋、可選取。
public enum OCRService {
    public struct RecognizedLine: Sendable {
        public let text: String
        /// Vision 的正規化座標（0~1，原點在左下）。
        public let normalizedBox: CGRect

        public init(text: String, normalizedBox: CGRect) {
            self.text = text
            self.normalizedBox = normalizedBox
        }
    }

    public enum Language: String, CaseIterable, Identifiable, Sendable {
        case traditionalChinese, simplifiedChinese, english, japanese

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .traditionalChinese: return "繁體中文＋英文"
            case .simplifiedChinese: return "簡體中文＋英文"
            case .english: return "英文"
            case .japanese: return "日文＋英文"
            }
        }

        public var visionLanguages: [String] {
            switch self {
            case .traditionalChinese: return ["zh-Hant", "en-US"]
            case .simplifiedChinese: return ["zh-Hans", "en-US"]
            case .english: return ["en-US"]
            case .japanese: return ["ja-JP", "en-US"]
            }
        }
    }

    /// 頁面是否已經有可選取的文字。
    public static func hasText(_ page: PDFPage) -> Bool {
        !(page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public static func recognizeText(in image: CGImage, languages: [String]) throws -> [RecognizedLine] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.revision = VNRecognizeTextRequestRevision3
        request.recognitionLanguages = languages
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try handler.perform([request])
        let observations = request.results ?? []
        return observations.compactMap { observation in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            return RecognizedLine(text: candidate.string, normalizedBox: observation.boundingBox)
        }
    }

    /// 框選範圍辨識出的一行：文字與外框（頁面座標）。
    public struct RegionLine: Sendable, Equatable {
        public let text: String
        public let box: CGRect

        public init(text: String, box: CGRect) {
            self.text = text
            self.box = box
        }
    }

    /// 重新辨識頁面上的某個範圍（頁面座標），回傳每一行的文字與外框（頁面座標）。
    public static func recognizeRegion(of page: PDFPage, rect: CGRect, languages: [String], dpi: CGFloat = 300) throws -> [RegionLine] {
        let mediaBox = page.bounds(for: .mediaBox)
        let area = rect.intersection(mediaBox)
        guard !area.isNull, area.width > 1, area.height > 1,
              let image = PageRenderer.unrotatedContentImage(for: page, dpi: dpi) else { return [] }
        let scale = dpi / 72
        // CGImage 的原點在左上
        let pixels = CGRect(x: (area.minX - mediaBox.minX) * scale, y: (mediaBox.maxY - area.maxY) * scale, width: area.width * scale, height: area.height * scale)
            .integral
            .intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard !pixels.isNull, let cropped = image.cropping(to: pixels) else { return [] }
        // 實際裁切到的範圍（頁面座標）
        let cropRect = CGRect(x: mediaBox.minX + pixels.minX / scale, y: mediaBox.maxY - pixels.maxY / scale, width: pixels.width / scale, height: pixels.height / scale)
        return try recognizeText(in: cropped, languages: languages)
            .filter { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }
            .map { line in
                RegionLine(text: line.text, box: CGRect(
                    x: cropRect.minX + line.normalizedBox.minX * cropRect.width,
                    y: cropRect.minY + line.normalizedBox.minY * cropRect.height,
                    width: line.normalizedBox.width * cropRect.width,
                    height: line.normalizedBox.height * cropRect.height
                ))
            }
    }

    /// 建立含原始內容與隱形文字層的新頁面。`lines` 需以頁面 mediaBox（未旋轉）的影像辨識取得。
    public static func searchablePage(from page: PDFPage, lines: [RecognizedLine]) -> PDFPage? {
        let mediaBox = page.bounds(for: .mediaBox)
        return PageRenderer.makePage(like: page) { context in
            if let ref = page.pageRef {
                context.drawPDFPage(ref)
            }
            for line in lines where !line.text.isEmpty {
                let rect = CGRect(
                    x: mediaBox.minX + line.normalizedBox.minX * mediaBox.width,
                    y: mediaBox.minY + line.normalizedBox.minY * mediaBox.height,
                    width: line.normalizedBox.width * mediaBox.width,
                    height: line.normalizedBox.height * mediaBox.height
                )
                drawInvisibleText(line.text, in: rect, context: context)
            }
        }
    }

    private static func drawInvisibleText(_ text: String, in rect: CGRect, context: CGContext) {
        let fontSize = max(rect.height * 0.85, 1)
        let font = CTFontCreateWithName("PingFangTC-Regular" as CFString, fontSize, nil)
        let attributed = NSAttributedString(string: text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
        ])
        let line = CTLineCreateWithAttributedString(attributed)
        let width = CTLineGetTypographicBounds(line, nil, nil, nil)
        guard width > 0 else { return }

        context.saveGState()
        context.setTextDrawingMode(.invisible)
        context.textMatrix = .identity
        context.translateBy(x: rect.minX, y: rect.minY + rect.height * 0.15)
        context.scaleBy(x: rect.width / CGFloat(width), y: 1)
        context.textPosition = .zero
        CTLineDraw(line, context)
        context.restoreGState()
    }
}
