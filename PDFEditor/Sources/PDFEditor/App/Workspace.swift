import AppKit
import PDFEditorCore
import PDFKit
import SwiftUI
import UniformTypeIdentifiers

enum SheetKind: String, Identifiable {
    case watermark, pageNumbers, signatures, password, split, exportImages, ocr
    var id: String { rawValue }
}

enum SidebarTab: String, CaseIterable, Identifiable {
    case thumbnails, outline, annotations, search
    var id: String { rawValue }

    var title: String {
        switch self {
        case .thumbnails: return "縮圖"
        case .outline: return "書籤"
        case .annotations: return "註解"
        case .search: return "搜尋"
        }
    }

    var symbol: String {
        switch self {
        case .thumbnails: return "square.grid.2x2"
        case .outline: return "list.bullet.indent"
        case .annotations: return "text.bubble"
        case .search: return "magnifyingglass"
        }
    }
}

/// 新增（point）或編輯（annotation）文字方塊的要求。
struct TextBoxRequest: Identifiable {
    let id = UUID()
    let page: PDFPage
    let point: CGPoint?
    let annotation: PDFAnnotation?
}

struct ProgressState: Equatable {
    var title: String
    var completed: Int
    var total: Int
    var fraction: Double { total == 0 ? 0 : Double(completed) / Double(total) }
}

/// 所有開啟中文件（分頁）與全域介面狀態。
@MainActor
final class Workspace: ObservableObject {
    static let shared = Workspace()

    @Published private(set) var documents: [EditorDocument] = []
    @Published var currentID: UUID?
    @Published var activeSheet: SheetKind?
    @Published var progress: ProgressState?
    @Published var textBoxRequest: TextBoxRequest?
    @Published private(set) var recentURLs: [URL] = []
    @Published var showSidebar = true
    @Published var sidebarTab: SidebarTab = .thumbnails

    private let recentKey = "RecentFiles"

    private init() {
        let paths = UserDefaults.standard.stringArray(forKey: recentKey) ?? []
        recentURLs = paths.map { URL(fileURLWithPath: $0) }.filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    var current: EditorDocument? {
        documents.first { $0.id == currentID } ?? documents.first
    }

    // MARK: - 開啟與建立

    func showOpenPanel() {
        open(Panels.openPDFs())
    }

    /// 開啟 PDF；圖片會合成為新的 PDF。
    func open(_ urls: [URL]) {
        let pdfURLs = urls.filter { UTType(filenameExtension: $0.pathExtension)?.conforms(to: .pdf) == true }
        let imageURLs = urls.filter { UTType(filenameExtension: $0.pathExtension)?.conforms(to: .image) == true }
        for url in pdfURLs {
            openPDF(at: url)
        }
        if !imageURLs.isEmpty {
            createFromImages(imageURLs)
        }
    }

    private func openPDF(at url: URL) {
        let standardized = url.standardizedFileURL
        if let existing = documents.first(where: { $0.fileURL?.standardizedFileURL == standardized }) {
            currentID = existing.id
            return
        }
        guard let pdf = PDFDocument(url: url) else {
            Panels.showMessage(title: "無法開啟", message: "「\(url.lastPathComponent)」不是有效的 PDF 檔案或已損毀。", style: .critical)
            return
        }
        var security: SecurityOptions?
        if pdf.isLocked {
            guard let password = unlock(pdf, name: url.lastPathComponent) else { return }
            security = SecurityOptions(userPassword: password)
        } else if pdf.isEncrypted {
            // 只有權限限制、不需密碼即可開啟的文件，存檔時不再加密。
            security = nil
        }
        add(EditorDocument(pdf: pdf, fileURL: url, security: security))
        noteRecent(url)
    }

    private func unlock(_ pdf: PDFDocument, name: String) -> String? {
        var message = "「\(name)」受密碼保護，請輸入密碼："
        while true {
            guard let password = Panels.promptText(title: "需要密碼", message: message, secure: true) else { return nil }
            if pdf.unlock(withPassword: password) { return password }
            message = "密碼錯誤，請再試一次："
        }
    }

    func newBlankDocument() {
        let pdf = PDFDocument()
        pdf.insert(PageOperations.blankPage(), at: 0)
        let document = EditorDocument(pdf: pdf, fileURL: nil)
        add(document)
        document.markChanged()
    }

    func showCreateFromImagesPanel() {
        let urls = Panels.openImages(title: "選擇要轉成 PDF 的圖片")
        if !urls.isEmpty { createFromImages(urls) }
    }

    func createFromImages(_ urls: [URL]) {
        let pdf = ExportService.document(fromImagesAt: urls.sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending })
        guard pdf.pageCount > 0 else {
            Panels.showMessage(title: "無法建立 PDF", message: "選擇的檔案中沒有可讀取的圖片。", style: .warning)
            return
        }
        let document = EditorDocument(pdf: pdf, fileURL: nil)
        add(document)
        document.markChanged()
    }

    func showMergePanel() {
        let urls = Panels.openPDFs(title: "選擇要合併的 PDF（依選擇順序合併）")
        guard urls.count >= 1 else { return }
        let documents = urls.compactMap { url -> PDFDocument? in
            guard let pdf = PDFDocument(url: url) else { return nil }
            if pdf.isLocked, unlock(pdf, name: url.lastPathComponent) == nil { return nil }
            return pdf
        }
        guard !documents.isEmpty else { return }
        let merged = PageOperations.merge(documents)
        let document = EditorDocument(pdf: merged, fileURL: nil)
        add(document)
        document.markChanged()
    }

    private func add(_ document: EditorDocument) {
        documents.append(document)
        currentID = document.id
    }

    // MARK: - 關閉

    /// 關閉分頁；有未儲存變更時先詢問。回傳是否已關閉。
    @discardableResult
    func close(_ document: EditorDocument) -> Bool {
        if document.isDirty {
            currentID = document.id
            switch Panels.askToSave(name: document.displayName) {
            case .save:
                guard document.save() else { return false }
            case .discard:
                break
            case .cancel:
                return false
            }
        }
        let index = documents.firstIndex { $0.id == document.id }
        documents.removeAll { $0.id == document.id }
        if currentID == document.id, let index {
            currentID = documents.isEmpty ? nil : documents[min(index, documents.count - 1)].id
        }
        return true
    }

    func closeCurrent() {
        if let current { close(current) }
    }

    /// 結束程式前逐一確認未儲存的文件。
    func closeAllForTermination() -> Bool {
        for document in documents where document.isDirty {
            guard close(document) else { return false }
        }
        return true
    }

    // MARK: - 最近開啟

    func noteRecent(_ url: URL) {
        var urls = recentURLs.filter { $0.standardizedFileURL != url.standardizedFileURL }
        urls.insert(url, at: 0)
        recentURLs = Array(urls.prefix(10))
        UserDefaults.standard.set(recentURLs.map(\.path), forKey: recentKey)
        NSDocumentController.shared.noteNewRecentDocumentURL(url)
    }

    func clearRecent() {
        recentURLs = []
        UserDefaults.standard.removeObject(forKey: recentKey)
    }

    // MARK: - 長時間作業

    func beginProgress(_ title: String, total: Int) {
        progress = ProgressState(title: title, completed: 0, total: total)
    }

    func updateProgress(_ completed: Int) {
        progress?.completed = completed
    }

    func endProgress() {
        progress = nil
    }
}
