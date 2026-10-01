import Foundation
import PDFKit

/// 頁面層級的操作：旋轉、插入、搬移、擷取、合併與分割。
public enum PageOperations {
    /// A4 直式（點）。
    public static let a4Size = CGSize(width: 595.28, height: 841.89)
    /// US Letter 直式（點）。
    public static let letterSize = CGSize(width: 612, height: 792)

    public static func blankPage(size: CGSize = a4Size) -> PDFPage {
        let page = PDFPage()
        page.setBounds(CGRect(origin: .zero, size: size), for: .mediaBox)
        return page
    }

    /// 取得可插入其他文件的頁面副本（含標準註解）。
    ///
    /// 自訂註解（圖片、浮水印、遮蓋標記等）無法由 PDFKit 複製，複製前暫時移除，完成後放回原頁。
    public static func copy(_ page: PDFPage) -> PDFPage {
        let custom = page.annotations.filter { $0 is CustomDrawnAnnotation || $0 is RedactionMarkAnnotation }
        custom.forEach { page.removeAnnotation($0) }
        defer { custom.forEach { page.addAnnotation($0) } }
        return (page.copy() as? PDFPage) ?? page
    }

    /// 旋轉角度正規化為 0、90、180、270。
    public static func normalizedRotation(_ degrees: Int) -> Int {
        let r = degrees % 360
        let positive = r < 0 ? r + 360 : r
        return (positive / 90) * 90
    }

    public static func rotate(_ page: PDFPage, by degrees: Int) {
        page.rotation = normalizedRotation(page.rotation + degrees)
    }

    public static func pages(of document: PDFDocument) -> [PDFPage] {
        (0..<document.pageCount).compactMap { document.page(at: $0) }
    }

    /// 以指定順序重建文件的頁面清單。
    public static func setPages(_ pages: [PDFPage], of document: PDFDocument) {
        for index in stride(from: document.pageCount - 1, through: 0, by: -1) {
            document.removePage(at: index)
        }
        for page in pages {
            document.insert(page, at: document.pageCount)
        }
    }

    /// 依 `List.onMove` 的語意搬移元素。
    public static func move<T>(_ items: [T], from source: IndexSet, to destination: Int) -> [T] {
        let moving = source.sorted().map { items[$0] }
        var remaining = items.enumerated().filter { !source.contains($0.offset) }.map(\.element)
        let insertAt = destination - source.filter { $0 < destination }.count
        remaining.insert(contentsOf: moving, at: max(0, min(insertAt, remaining.count)))
        return remaining
    }

    public static func extract(pageIndices: [Int], from document: PDFDocument) -> PDFDocument {
        let result = PDFDocument()
        for index in pageIndices {
            if let page = document.page(at: index) {
                result.insert(copy(page), at: result.pageCount)
            }
        }
        return result
    }

    public static func merge(_ documents: [PDFDocument]) -> PDFDocument {
        let result = PDFDocument()
        for document in documents {
            for page in pages(of: document) {
                result.insert(copy(page), at: result.pageCount)
            }
        }
        return result
    }

    /// 每 `pagesPerFile` 頁分割成一份文件。
    public static func split(_ document: PDFDocument, every pagesPerFile: Int) -> [PDFDocument] {
        guard pagesPerFile > 0, document.pageCount > 0 else { return [] }
        return stride(from: 0, to: document.pageCount, by: pagesPerFile).map { start in
            let end = min(start + pagesPerFile, document.pageCount)
            return extract(pageIndices: Array(start..<end), from: document)
        }
    }

    /// 依頁碼範圍（從 0 起算）分割。
    public static func split(_ document: PDFDocument, ranges: [ClosedRange<Int>]) -> [PDFDocument] {
        ranges.map { extract(pageIndices: Array($0), from: document) }
    }

    /// 解析使用者輸入的頁碼範圍，例如 `1-3, 5, 8-`。
    ///
    /// 輸入以 1 起算，回傳以 0 起算的範圍；格式錯誤或超出頁數時回傳 nil。
    public static func parsePageRanges(_ text: String, pageCount: Int) -> [ClosedRange<Int>]? {
        let normalized = text
            .replacingOccurrences(of: "，", with: ",")
            .replacingOccurrences(of: "、", with: ",")
            .replacingOccurrences(of: "～", with: "-")
            .replacingOccurrences(of: "~", with: "-")
            .replacingOccurrences(of: "–", with: "-")
        let parts = normalized.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !parts.isEmpty, pageCount > 0 else { return nil }

        var ranges: [ClosedRange<Int>] = []
        for part in parts {
            if part.contains("-") {
                let bounds = part.split(separator: "-", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
                guard bounds.count == 2 else { return nil }
                let lower = bounds[0].isEmpty ? 1 : Int(bounds[0])
                let upper = bounds[1].isEmpty ? pageCount : Int(bounds[1])
                guard let lower, let upper, lower >= 1, upper <= pageCount, lower <= upper else { return nil }
                ranges.append((lower - 1)...(upper - 1))
            } else {
                guard let page = Int(part), page >= 1, page <= pageCount else { return nil }
                ranges.append((page - 1)...(page - 1))
            }
        }
        return ranges
    }

    /// 將範圍展開為不重複、排序過的頁面索引。
    public static func indices(from ranges: [ClosedRange<Int>]) -> [Int] {
        Array(Set(ranges.flatMap { Array($0) })).sorted()
    }
}

/// 頁碼文字樣板，支援 `{n}`（目前頁碼）與 `{total}`（總頁數）。
public enum PageNumberFormat {
    public static let presets = ["{n}", "第 {n} 頁", "{n} / {total}", "第 {n} 頁，共 {total} 頁", "Page {n} of {total}"]

    public static func render(_ template: String, page: Int, total: Int) -> String {
        template
            .replacingOccurrences(of: "{n}", with: String(page))
            .replacingOccurrences(of: "{total}", with: String(total))
    }
}
