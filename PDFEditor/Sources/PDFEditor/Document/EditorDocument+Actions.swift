import AppKit
import PDFEditorCore
import PDFKit
import UniformTypeIdentifiers

/// 需要開檔／存檔面板或背景處理的文件動作。
extension EditorDocument {
    func showInsertPagesPanel() {
        let urls = Panels.openPDFs(title: "選擇要插入的 PDF")
        let documents = urls.compactMap { PDFDocument(url: $0) }.filter { !$0.isLocked }
        if documents.count < urls.count {
            Panels.showMessage(title: "部分檔案無法插入", message: "受密碼保護或損毀的檔案已略過。", style: .warning)
        }
        let after = targetPageIndices.max()
        insertPages(from: documents, after: after)
    }

    func extractPages(_ indices: [Int]) {
        guard !indices.isEmpty else { return }
        let suggested = "\(baseName)-擷取頁面.pdf"
        guard let url = Panels.save(title: "擷取頁面", suggestedName: suggested) else { return }
        bakeCustomAnnotations()
        do {
            try ExportService.write(PageOperations.extract(pageIndices: indices.sorted(), from: pdf), to: url, security: nil)
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } catch {
            Panels.showError(error, title: "無法擷取頁面")
        }
    }

    func split(ranges: [ClosedRange<Int>]?, every pagesPerFile: Int) {
        let preview = ranges.map { $0.count } ?? (pdf.pageCount + pagesPerFile - 1) / max(pagesPerFile, 1)
        guard preview > 0, let folder = Panels.chooseFolder(title: "選擇分割後檔案的存放資料夾") else { return }
        bakeCustomAnnotations()
        let parts = ranges.map { PageOperations.split(pdf, ranges: $0) } ?? PageOperations.split(pdf, every: pagesPerFile)
        do {
            var written: [URL] = []
            for (offset, part) in parts.enumerated() {
                let url = folder.appendingPathComponent("\(baseName)-\(offset + 1).pdf")
                try ExportService.write(part, to: url, security: nil)
                written.append(url)
            }
            NSWorkspace.shared.activateFileViewerSelecting(written)
        } catch {
            Panels.showError(error, title: "分割失敗")
        }
    }

    func exportImages(pageIndices: [Int], format: ImageExportFormat, dpi: CGFloat) {
        guard let folder = Panels.chooseFolder(title: "選擇圖片存放資料夾") else { return }
        let workspace = Workspace.shared
        workspace.beginProgress("正在匯出圖片…", total: pageIndices.count)
        Task { @MainActor in
            defer { workspace.endProgress() }
            var written: [URL] = []
            do {
                for (offset, index) in pageIndices.enumerated() {
                    written += try ExportService.exportImages(from: pdf, pageIndices: [index], to: folder, baseName: baseName, format: format, dpi: dpi)
                    workspace.updateProgress(offset + 1)
                    await Task.yield()
                }
                NSWorkspace.shared.activateFileViewerSelecting(written)
            } catch {
                Panels.showError(error, title: "匯出失敗")
            }
        }
    }

    func exportText() {
        guard let url = Panels.save(title: "匯出文字", suggestedName: "\(baseName).txt", type: .plainText) else { return }
        do {
            try ExportService.plainText(of: pdf).write(to: url, atomically: true, encoding: .utf8)
        } catch {
            Panels.showError(error, title: "匯出失敗")
        }
    }

    func exportCompressed() {
        guard let url = Panels.save(title: "匯出壓縮版本", suggestedName: "\(baseName)-壓縮.pdf") else { return }
        do {
            bakeCustomAnnotations()
            try ExportService.writeCompressed(pdf, to: url)
            let before = fileURL.flatMap { try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize }
            let after = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize
            let formatter = ByteCountFormatter()
            var message = "已儲存至「\(url.lastPathComponent)」。"
            if let before, let after {
                message += "\n原始大小：\(formatter.string(fromByteCount: Int64(before)))\n壓縮後：\(formatter.string(fromByteCount: Int64(after)))"
            }
            Panels.showMessage(title: "壓縮完成", message: message)
        } catch {
            Panels.showError(error, title: "壓縮失敗")
        }
    }

    /// 文字辨識：逐頁點陣化後以 Vision 辨識，再以含隱形文字層的新頁面取代。
    func runOCR(language: OCRService.Language, onlyPagesWithoutText: Bool) {
        let targets = pages.filter { !onlyPagesWithoutText || !OCRService.hasText($0) }
        guard !targets.isEmpty else {
            Panels.showMessage(title: "不需要辨識", message: "所有頁面都已經有可選取的文字。")
            return
        }
        let workspace = Workspace.shared
        workspace.beginProgress("正在辨識文字（OCR）…", total: targets.count)
        let languages = language.visionLanguages

        Task { @MainActor in
            defer { workspace.endProgress() }
            var replacements: [PageReplacement] = []
            var recognizedLines = 0
            do {
                for (offset, page) in targets.enumerated() {
                    guard let image = PageRenderer.unrotatedContentImage(for: page, dpi: 300) else { continue }
                    let lines = try await Task.detached(priority: .userInitiated) {
                        try OCRService.recognizeText(in: image, languages: languages)
                    }.value
                    recognizedLines += lines.count
                    if !lines.isEmpty, let newPage = OCRService.searchablePage(from: page, lines: lines) {
                        let kept = page.annotations.filter { !$0.isType(.popup) }
                        replacements.append(PageReplacement(oldPage: page, newPage: newPage, movedAnnotations: kept))
                    }
                    workspace.updateProgress(offset + 1)
                }
            } catch {
                Panels.showError(error, title: "文字辨識失敗")
                return
            }
            applyReplacements(replacements, actionName: "文字辨識")
            Panels.showMessage(
                title: "文字辨識完成",
                message: "處理 \(targets.count) 頁，辨識出 \(recognizedLines) 行文字。現在可以搜尋及選取這些文字。"
            )
        }
    }
}
