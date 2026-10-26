import AppKit
import PDFKit

/// 以自訂繪圖呈現的註解（圖片、簽名、浮水印、頁碼）。
///
/// 標準 PDF 註解沒有辦法描述這些內容，因此存檔時會把它們「燒進」頁面內容，
/// 請見 `PageFlattener.bakeCustomAnnotations(in:)`。
open class CustomDrawnAnnotation: PDFAnnotation {
    public override init(bounds: CGRect, forType annotationType: PDFAnnotationSubtype, withProperties properties: [AnyHashable: Any]?) {
        super.init(bounds: bounds, forType: annotationType, withProperties: properties)
    }

    public required init?(coder: NSCoder) {
        super.init(coder: coder)
    }

    /// 是否允許使用者以滑鼠拖曳移動。
    open var isUserMovable: Bool { true }

    /// 複製頁面時使用的複本（PDFKit 無法複製自訂註解）。
    open func duplicate() -> PDFAnnotation? { nil }

    /// PDFKit 呼叫 `draw(with:in:)` 時，座標系統是「畫面方向」（已套用頁面旋轉與裁切位移），
    /// 頁面座標要經 `page.transform(for:)` 換算。回傳外框在畫面方向下的位置，內容直接畫在其中就會是正的。
    public func displayRect(_ rect: CGRect, for box: PDFDisplayBox) -> CGRect {
        guard let page else { return rect }
        return rect.applying(page.transform(for: box))
    }
}

/// 圖片或手寫簽名。
public final class ImageStampAnnotation: CustomDrawnAnnotation {
    public let image: CGImage
    public let isSignature: Bool

    public init(image: CGImage, bounds: CGRect, isSignature: Bool = false) {
        self.image = image
        self.isSignature = isSignature
        super.init(bounds: bounds, forType: .stamp, withProperties: nil)
        contents = isSignature ? "簽名" : "圖片"
    }

    public required init?(coder: NSCoder) {
        return nil
    }

    public override func duplicate() -> PDFAnnotation? {
        ImageStampAnnotation(image: image, bounds: bounds, isSignature: isSignature)
    }

    public override func draw(with box: PDFDisplayBox, in context: CGContext) {
        context.saveGState()
        context.interpolationQuality = .high
        context.draw(image, in: displayRect(bounds, for: box))
        context.restoreGState()
    }
}

/// 覆蓋整頁、置中旋轉的文字浮水印。
public final class WatermarkAnnotation: CustomDrawnAnnotation {
    public let text: String
    public let fontSize: CGFloat
    public let textColor: NSColor
    public let opacity: CGFloat
    public let angle: CGFloat

    public init(pageBounds: CGRect, text: String, fontSize: CGFloat, color: NSColor, opacity: CGFloat, angle: CGFloat) {
        self.text = text
        self.fontSize = fontSize
        self.textColor = color
        self.opacity = opacity
        self.angle = angle
        super.init(bounds: pageBounds, forType: .stamp, withProperties: nil)
        contents = "浮水印：\(text)"
    }

    public required init?(coder: NSCoder) {
        return nil
    }

    public override func duplicate() -> PDFAnnotation? {
        WatermarkAnnotation(pageBounds: bounds, text: text, fontSize: fontSize, color: textColor, opacity: opacity, angle: angle)
    }

    public override var isUserMovable: Bool { false }

    public override func draw(with box: PDFDisplayBox, in context: CGContext) {
        let attributed = NSAttributedString(string: text, attributes: [
            .font: TextDrawing.font(size: fontSize, bold: true),
            .foregroundColor: textColor,
        ])
        let size = attributed.size()
        context.saveGState()
        context.setAlpha(opacity)
        let rect = displayRect(bounds, for: box)
        context.translateBy(x: rect.midX, y: rect.midY)
        context.rotate(by: angle * .pi / 180)
        TextDrawing.draw(attributed, at: CGPoint(x: -size.width / 2, y: -size.height / 2), in: context)
        context.restoreGState()
    }
}

/// 頁碼、頁首與頁尾文字的位置。
public enum StampPosition: String, CaseIterable, Identifiable, Sendable {
    case topLeft, topCenter, topRight, bottomLeft, bottomCenter, bottomRight

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .topLeft: return "左上"
        case .topCenter: return "上方置中"
        case .topRight: return "右上"
        case .bottomLeft: return "左下"
        case .bottomCenter: return "下方置中"
        case .bottomRight: return "右下"
        }
    }

    /// 依頁面大小與文字尺寸計算繪製原點（PDF 座標，原點在左下）。
    public func origin(for textSize: CGSize, in pageBounds: CGRect, margin: CGFloat) -> CGPoint {
        let x: CGFloat
        switch self {
        case .topLeft, .bottomLeft: x = pageBounds.minX + margin
        case .topCenter, .bottomCenter: x = pageBounds.midX - textSize.width / 2
        case .topRight, .bottomRight: x = pageBounds.maxX - margin - textSize.width
        }
        let y: CGFloat
        switch self {
        case .topLeft, .topCenter, .topRight: y = pageBounds.maxY - margin - textSize.height
        case .bottomLeft, .bottomCenter, .bottomRight: y = pageBounds.minY + margin
        }
        return CGPoint(x: x, y: y)
    }
}

/// 頁碼／頁首頁尾文字。
public final class TextStampAnnotation: CustomDrawnAnnotation {
    public let text: String
    public let fontSize: CGFloat
    public let textColor: NSColor
    public let position: StampPosition
    public let margin: CGFloat

    public init(pageBounds: CGRect, text: String, fontSize: CGFloat, color: NSColor, position: StampPosition, margin: CGFloat) {
        self.text = text
        self.fontSize = fontSize
        self.textColor = color
        self.position = position
        self.margin = margin
        super.init(bounds: pageBounds, forType: .stamp, withProperties: nil)
        contents = "頁碼／頁首頁尾：\(text)"
    }

    public required init?(coder: NSCoder) {
        return nil
    }

    public override func duplicate() -> PDFAnnotation? {
        TextStampAnnotation(pageBounds: bounds, text: text, fontSize: fontSize, color: textColor, position: position, margin: margin)
    }

    public override var isUserMovable: Bool { false }

    public override func draw(with box: PDFDisplayBox, in context: CGContext) {
        let attributed = NSAttributedString(string: text, attributes: [
            .font: TextDrawing.font(size: fontSize, bold: false),
            .foregroundColor: textColor,
        ])
        // 位置以畫面方向計算：旋轉的頁面上頁碼仍在畫面的下方
        let origin = position.origin(for: attributed.size(), in: displayRect(bounds, for: box), margin: margin)
        TextDrawing.draw(attributed, at: origin, in: context)
    }
}

/// 旋轉過的頁面上的文字方塊：PDFKit 的文字方塊會跟著頁面一起轉（在畫面上側躺），
/// 這裡改以畫面方向繪製；存檔時與圖片一樣固定到頁面中（成為可搜尋、可用「編輯文字」修改的文字）。
public final class UprightTextBoxAnnotation: CustomDrawnAnnotation {
    public init(bounds: CGRect) {
        super.init(bounds: bounds, forType: .freeText, withProperties: nil)
    }

    public required init?(coder: NSCoder) {
        return nil
    }

    public override func duplicate() -> PDFAnnotation? {
        let copy = UprightTextBoxAnnotation(bounds: bounds)
        copy.color = color
        copy.border = border
        copy.contents = contents
        copy.font = font
        copy.fontColor = fontColor
        return copy
    }

    public override func draw(with box: PDFDisplayBox, in context: CGContext) {
        let attributed = NSAttributedString(string: contents ?? "", attributes: [
            .font: font ?? TextDrawing.font(size: 14, bold: false),
            .foregroundColor: fontColor ?? .black,
        ])
        let rect = displayRect(bounds, for: box).insetBy(dx: FreeTextStyle.padding.width / 2, dy: FreeTextStyle.padding.height / 2)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
        attributed.draw(with: rect, options: [.usesLineFragmentOrigin, .usesFontLeading])
        NSGraphicsContext.restoreGraphicsState()
    }
}

/// 標記待套用的遮蓋（塗黑）區域；套用後會將頁面點陣化並真正移除底下內容。
public final class RedactionMarkAnnotation: PDFAnnotation {
    public init(bounds: CGRect) {
        super.init(bounds: bounds, forType: .square, withProperties: nil)
        color = NSColor.systemRed
        interiorColor = NSColor.systemRed.withAlphaComponent(0.25)
        let border = PDFBorder()
        border.lineWidth = 1.5
        border.style = .dashed
        border.dashPattern = [4, 3]
        self.border = border
        contents = "待套用遮蓋"
    }

    public override init(bounds: CGRect, forType annotationType: PDFAnnotationSubtype, withProperties properties: [AnyHashable: Any]?) {
        super.init(bounds: bounds, forType: annotationType, withProperties: properties)
    }

    public required init?(coder: NSCoder) {
        super.init(coder: coder)
    }
}

public enum TextDrawing {
    /// 優先使用蘋方繁中字型，讓中文顯示正確。
    public static func font(size: CGFloat, bold: Bool) -> NSFont {
        let name = bold ? "PingFangTC-Semibold" : "PingFangTC-Regular"
        return NSFont(name: name, size: size) ?? NSFont.systemFont(ofSize: size, weight: bold ? .semibold : .regular)
    }

    public static func draw(_ string: NSAttributedString, at point: CGPoint, in context: CGContext) {
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
        string.draw(at: point)
        NSGraphicsContext.restoreGraphicsState()
    }
}
