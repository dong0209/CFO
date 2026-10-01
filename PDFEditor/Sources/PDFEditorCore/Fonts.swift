import AppKit
import PDFKit

public struct FontFamily: Identifiable, Hashable, Sendable {
    /// 字族名稱（英文，例如 `PingFang TC`）
    public let name: String
    /// 顯示名稱（依系統語言，例如「蘋方-繁」）
    public let displayName: String
    public var id: String { name }
}

public struct FontFace: Identifiable, Hashable, Sendable {
    public let postScriptName: String
    /// 樣式顯示名稱（例如「粗體」）
    public let displayName: String
    public let weight: Int
    public var id: String { postScriptName }
}

/// 系統已安裝的字型清單。
public enum FontCatalog {
    public static let defaultFamily = "PingFang TC"

    /// 排在最前面的常用字型（未安裝的會自動略過）。
    public static let recommendedNames = [
        "PingFang TC", "Heiti TC", "Songti TC", "Kaiti TC", "BiauKai", "Lantinghei TC", "Yuanti TC",
        "Weibei TC", "Libian TC", "Xingkai TC", "Hannotate TC", "HanziPen TC", "Wawati TC", "LiSong Pro", "LiHei Pro",
        "Helvetica Neue", "Helvetica", "Arial", "Times New Roman", "Georgia", "Avenir Next", "Futura", "Menlo", "Courier New",
    ]

    public static func displayName(of family: String) -> String {
        NSFontManager.shared.localizedName(forFamily: family, face: nil)
    }

    public static func allFamilies() -> [FontFamily] {
        NSFontManager.shared.availableFontFamilies
            .filter { !$0.hasPrefix(".") }
            .map { FontFamily(name: $0, displayName: displayName(of: $0)) }
            .sorted { $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending }
    }

    /// 常用字型與其他字型（不重複）。
    public static func groupedFamilies() -> (recommended: [FontFamily], others: [FontFamily]) {
        let all = allFamilies()
        let installed = Dictionary(uniqueKeysWithValues: all.map { ($0.name, $0) })
        let recommended = recommendedNames.compactMap { installed[$0] }
        let recommendedSet = Set(recommended.map(\.name))
        return (recommended, all.filter { !recommendedSet.contains($0.name) })
    }

    public static func faces(of family: String) -> [FontFace] {
        let members = NSFontManager.shared.availableMembers(ofFontFamily: family) ?? []
        return members.compactMap { member in
            guard member.count >= 3,
                  let postScriptName = member[0] as? String,
                  let style = member[1] as? String else { return nil }
            let weight = (member[2] as? NSNumber)?.intValue ?? 5
            let localized = NSFontManager.shared.localizedName(forFamily: family, face: style)
            let displayName = localized.isEmpty || localized == family ? style : localized.replacingOccurrences(of: displayName(of: family), with: "").trimmingCharacters(in: .whitespaces)
            return FontFace(postScriptName: postScriptName, displayName: displayName.isEmpty ? style : displayName, weight: weight)
        }
    }

    /// 字族的一般（非粗體、非斜體）樣式。
    public static func regularFace(of family: String) -> FontFace? {
        let faces = faces(of: family)
        return faces.min { abs($0.weight - 5) < abs($1.weight - 5) } ?? faces.first
    }

    /// 依字族與樣式取得字型；找不到時退回系統中文字型。
    public static func font(family: String, face: String?, size: CGFloat) -> NSFont {
        if let face, let font = NSFont(name: face, size: size) { return font }
        if let regular = regularFace(of: family), let font = NSFont(name: regular.postScriptName, size: size) { return font }
        return NSFontManager.shared.font(withFamily: family, traits: [], weight: 5, size: size) ?? TextDrawing.font(size: size, bold: false)
    }
}

/// 文字方塊（FreeText 註解）的建立與樣式設定。
public enum FreeTextStyle {
    public static let maxWidth: CGFloat = 400

    /// 以左上角為基準，依文字與字型計算外框（PDF 座標，原點在左下）。
    public static func bounds(for text: String, font: NSFont, topLeft: CGPoint) -> CGRect {
        let measured = ((text.isEmpty ? " " : text) as NSString).boundingRect(
            with: CGSize(width: maxWidth, height: 10_000),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font]
        )
        let size = CGSize(width: ceil(measured.width) + 12, height: ceil(measured.height) + 8)
        return CGRect(x: topLeft.x, y: topLeft.y - size.height, width: size.width, height: size.height)
    }

    public static func make(text: String, font: NSFont, color: NSColor, topLeft: CGPoint) -> PDFAnnotation {
        let annotation = PDFAnnotation(bounds: bounds(for: text, font: font, topLeft: topLeft), forType: .freeText, withProperties: nil)
        annotation.color = .clear
        annotation.alignment = .left
        let border = PDFBorder()
        border.lineWidth = 0
        annotation.border = border
        apply(text: text, font: font, color: color, to: annotation)
        return annotation
    }

    /// 套用文字、字型與顏色，並保持左上角位置。
    public static func apply(text: String, font: NSFont, color: NSColor, to annotation: PDFAnnotation) {
        let old = annotation.bounds
        annotation.contents = text
        annotation.font = font
        annotation.fontColor = color
        annotation.bounds = bounds(for: text, font: font, topLeft: CGPoint(x: old.minX, y: old.maxY))
    }
}
