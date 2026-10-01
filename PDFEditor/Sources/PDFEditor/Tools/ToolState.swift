import AppKit
import PDFEditorCore
import SwiftUI

enum Tool: String, CaseIterable, Identifiable {
    case select, editText, highlight, underline, strikeout
    case note, textBox, ink
    case rectangle, ellipse, line, arrow
    case whiteout, redact, image, signature, eraser

    var id: String { rawValue }

    var title: String {
        switch self {
        case .select: return "選取"
        case .editText: return "編輯文字"
        case .highlight: return "螢光筆"
        case .underline: return "底線"
        case .strikeout: return "刪除線"
        case .note: return "便利貼"
        case .textBox: return "文字方塊"
        case .ink: return "手繪"
        case .rectangle: return "矩形"
        case .ellipse: return "橢圓"
        case .line: return "直線"
        case .arrow: return "箭頭"
        case .whiteout: return "白底遮蓋"
        case .redact: return "塗黑遮蓋"
        case .image: return "圖片"
        case .signature: return "簽名"
        case .eraser: return "橡皮擦"
        }
    }

    var symbol: String {
        switch self {
        case .select: return "cursorarrow"
        case .editText: return "character.cursor.ibeam"
        case .highlight: return "highlighter"
        case .underline: return "underline"
        case .strikeout: return "strikethrough"
        case .note: return "note.text"
        case .textBox: return "character.textbox"
        case .ink: return "pencil.tip"
        case .rectangle: return "rectangle"
        case .ellipse: return "circle"
        case .line: return "line.diagonal"
        case .arrow: return "arrow.up.right"
        case .whiteout: return "rectangle.fill"
        case .redact: return "rectangle.inset.filled"
        case .image: return "photo"
        case .signature: return "signature"
        case .eraser: return "eraser"
        }
    }

    /// 在工具選單中的快捷鍵。
    var shortcut: KeyEquivalent? {
        switch self {
        case .select: return "v"
        case .editText: return "g"
        case .highlight: return "y"
        case .underline: return "u"
        case .strikeout: return "k"
        case .note: return "n"
        case .textBox: return "b"
        case .ink: return "p"
        case .rectangle: return "r"
        case .ellipse: return "o"
        case .line: return "l"
        case .arrow: return "a"
        case .whiteout: return "i"
        case .redact: return "x"
        case .eraser: return "e"
        case .image, .signature: return nil
        }
    }

    var isTextMarkup: Bool { self == .highlight || self == .underline || self == .strikeout }

    /// 以拖曳範圍建立的工具。
    var isDragShape: Bool {
        [.rectangle, .ellipse, .line, .arrow, .whiteout, .redact].contains(self)
    }

    var usesColor: Bool {
        ![.select, .editText, .whiteout, .redact, .image, .signature, .eraser].contains(self)
    }

    var usesLineWidth: Bool { [.ink, .rectangle, .ellipse, .line, .arrow].contains(self) }
    var usesFontSize: Bool { self == .textBox }

    var defaultColor: Color {
        switch self {
        case .highlight: return .yellow
        case .underline: return .green
        case .strikeout, .ink, .rectangle, .ellipse, .line, .arrow: return .red
        case .note: return .yellow
        default: return .black
        }
    }

    static let groups: [[Tool]] = [
        [.select, .editText],
        [.highlight, .underline, .strikeout],
        [.note, .textBox, .ink],
        [.rectangle, .ellipse, .line, .arrow],
        [.whiteout, .redact],
        [.image, .signature, .eraser],
    ]
}

@MainActor
final class ToolState: ObservableObject {
    static let shared = ToolState()

    @Published var tool: Tool = .select {
        didSet {
            if tool != oldValue, !keepsColorOnToolChange { color = tool.defaultColor }
        }
    }
    @Published var color: Color = .black
    @Published var lineWidth: CGFloat = 2
    @Published var fontSize: CGFloat = 14
    /// 文字方塊使用的字族與樣式（PostScript 名稱；nil 代表一般樣式）
    @Published var fontFamily: String = UserDefaults.standard.string(forKey: "TextFontFamily") ?? FontCatalog.defaultFamily {
        didSet { UserDefaults.standard.set(fontFamily, forKey: "TextFontFamily") }
    }
    @Published var fontFace: String? = UserDefaults.standard.string(forKey: "TextFontFace") {
        didSet { UserDefaults.standard.set(fontFace, forKey: "TextFontFace") }
    }
    @Published var fillShapes = false

    /// 圖片／簽名工具下一次點擊要放置的影像。
    @Published var pendingImage: CGImage?

    private var keepsColorOnToolChange = false

    var nsColor: NSColor { NSColor(color) }

    var textFont: NSFont { FontCatalog.font(family: fontFamily, face: fontFace, size: fontSize) }

    /// 記住最後使用的文字樣式，作為下次新增文字的預設值。
    func rememberTextStyle(family: String, face: String?, size: CGFloat, color: NSColor) {
        fontFamily = family
        fontFace = face
        fontSize = size
        self.color = Color(nsColor: color)
    }

    func select(_ tool: Tool) {
        self.tool = tool
    }

    func arm(image: CGImage, as tool: Tool) {
        pendingImage = image
        keepsColorOnToolChange = true
        self.tool = tool
        keepsColorOnToolChange = false
    }
}
