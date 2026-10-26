import AppKit
import ImageIO
import PDFKit
import UniformTypeIdentifiers

/// 密碼保護設定，存檔時套用。
public struct SecurityOptions: Equatable, Sendable {
    /// 開啟文件所需的密碼。
    public var userPassword: String?
    /// 變更權限所需的擁有者密碼。
    public var ownerPassword: String?

    public init(userPassword: String? = nil, ownerPassword: String? = nil) {
        self.userPassword = userPassword?.isEmpty == true ? nil : userPassword
        self.ownerPassword = ownerPassword?.isEmpty == true ? nil : ownerPassword
    }

    public var isEmpty: Bool { userPassword == nil && ownerPassword == nil }

    public var writeOptions: [PDFDocumentWriteOption: Any] {
        var options: [PDFDocumentWriteOption: Any] = [:]
        if let userPassword { options[.userPasswordOption] = userPassword }
        // 只設定開啟密碼時，擁有者密碼沿用開啟密碼，避免權限密碼為空。
        if let owner = ownerPassword ?? userPassword { options[.ownerPasswordOption] = owner }
        return options
    }
}

public enum ImageExportFormat: String, CaseIterable, Identifiable, Sendable {
    case png, jpeg

    public var id: String { rawValue }
    public var title: String { self == .png ? "PNG" : "JPEG" }
    public var fileExtension: String { self == .png ? "png" : "jpg" }
    public var utType: UTType { self == .png ? .png : .jpeg }
}

public enum ExportError: LocalizedError {
    case writeFailed(URL)
    case renderFailed(Int)

    public var errorDescription: String? {
        switch self {
        case .writeFailed(let url): return "無法寫入檔案：\(url.lastPathComponent)"
        case .renderFailed(let page): return "無法轉換第 \(page) 頁"
        }
    }
}

public enum ExportService {
    /// 建立不含加密的副本（用於移除密碼）。
    public static func unencryptedCopy(of document: PDFDocument) -> PDFDocument {
        let copy = PageOperations.merge([document])
        if let attributes = document.documentAttributes {
            copy.documentAttributes = attributes
        }
        return copy
    }

    /// 寫入 PDF：先寫到暫存檔再取代，避免覆寫仍在讀取中的原始檔案。
    public static func write(_ document: PDFDocument, to url: URL, security: SecurityOptions?, extraOptions: [PDFDocumentWriteOption: Any] = [:]) throws {
        var options = extraOptions
        var target = document
        if let security, !security.isEmpty {
            options.merge(security.writeOptions) { _, new in new }
        } else if document.isEncrypted {
            target = unencryptedCopy(of: document)
        }

        let fileManager = FileManager.default
        let tempDirectory = try fileManager.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: url, create: true)
        let tempURL = tempDirectory.appendingPathComponent(url.lastPathComponent)
        defer { try? fileManager.removeItem(at: tempDirectory) }

        guard target.write(to: tempURL, withOptions: options.isEmpty ? nil : options) else {
            throw ExportError.writeFailed(url)
        }
        if fileManager.fileExists(atPath: url.path) {
            _ = try fileManager.replaceItemAt(url, withItemAt: tempURL)
        } else {
            try fileManager.moveItem(at: tempURL, to: url)
        }
    }

    /// 壓縮：將圖片轉存為 JPEG 並依螢幕解析度最佳化。
    public static func writeCompressed(_ document: PDFDocument, to url: URL) throws {
        var options: [PDFDocumentWriteOption: Any] = [:]
        if #available(macOS 14, *) {
            options[.saveImagesAsJPEGOption] = true
            options[.optimizeImagesForScreenOption] = true
        }
        try write(document, to: url, security: nil, extraOptions: options)
    }

    public static func imageData(_ image: CGImage, format: ImageExportFormat, jpegQuality: CGFloat = 0.9) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, format.utType.identifier as CFString, 1, nil) else { return nil }
        let properties: [CFString: Any] = format == .jpeg ? [kCGImageDestinationLossyCompressionQuality: jpegQuality] : [:]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }

    /// 將指定頁面匯出為圖片，回傳寫入的檔案。
    @discardableResult
    public static func exportImages(from document: PDFDocument, pageIndices: [Int], to folder: URL, baseName: String, format: ImageExportFormat, dpi: CGFloat) throws -> [URL] {
        let digits = String(document.pageCount).count
        var written: [URL] = []
        for index in pageIndices {
            guard let page = document.page(at: index),
                  let image = PageRenderer.image(for: page, dpi: dpi),
                  let data = imageData(image, format: format) else { throw ExportError.renderFailed(index + 1) }
            let number = String(format: "%0\(digits)d", index + 1)
            let url = folder.appendingPathComponent("\(baseName)-\(number).\(format.fileExtension)")
            try data.write(to: url)
            written.append(url)
        }
        return written
    }

    /// 將圖片合成為 PDF，每張圖片一頁。
    public static func document(fromImagesAt urls: [URL]) -> PDFDocument {
        let document = PDFDocument()
        for url in urls {
            guard let image = NSImage(contentsOf: url), let page = PDFPage(image: image) else { continue }
            document.insert(page, at: document.pageCount)
        }
        return document
    }

    public static func plainText(of document: PDFDocument) -> String {
        (0..<document.pageCount).map { index in
            let text = document.page(at: index)?.string ?? ""
            return "--- 第 \(index + 1) 頁 ---\n\(text)"
        }.joined(separator: "\n\n")
    }
}
