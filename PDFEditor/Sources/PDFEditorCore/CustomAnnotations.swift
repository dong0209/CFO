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

    public override func draw(with box: PDFDisplayBox, in context: CGContext) {
        context.saveGState()
        context.interpolationQuality = .high
        context.draw(image, in: bounds)
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

    public override var isUserMovable: Bool { false }

    public override func draw(with box: PDFDisplayBox, in context: CGContext) {
        let attributed = NSAttributedString(string: text, attributes: [
            .font: TextDrawing.font(size: fontSize, bold: true),
            .foregroundColor: textColor,
        ])
        let size = attributed.size()
        context.saveGState()
        context.setAlpha(opacity)
        context.translateBy(x: bounds.midX, y: bounds.midY)
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

    public override var isUserMovable: Bool { false }

    public override func draw(with box: PDFDisplayBox, in context: CGContext) {
        let attributed = NSAttributedString(string: text, attributes: [
            .font: TextDrawing.font(size: fontSize, bold: false),
            .foregroundColor: textColor,
        ])
        let origin = position.origin(for: attributed.size(), in: bounds, margin: margin)
        TextDrawing.draw(attributed, at: origin, in: context)
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
