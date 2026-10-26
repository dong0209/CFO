import AppKit
import PDFEditorCore
import PDFKit
import UniformTypeIdentifiers

/// 需要開檔／存檔面板或背景處理的文件動作。
extension EditorDocument {
    func showInsertPagesPanel() {
        let urls = Panels.openPDFs(title: "選擇要插入的 PDF")
        // 受密碼保護的檔案先要求輸入密碼
        let documents = urls.compactMap { url -> PDFDocument? in
            guard let pdf = PDFDocument(url: url) else { return nil }
            if pdf.isLocked, Workspace.shared.unlock(pdf, name: url.lastPathComponent) == nil { return nil }
            return pdf
        }
        if documents.count < urls.count {
            Panels.showMessage(title: "部分檔案未插入", message: "損毀或未輸入密碼的檔案已略過。", style: .warning)
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

    /// 以指定強度（low／medium／high）壓縮並另存；透過 MuPDF 引擎把較大的影像降採樣。
    func compressDocument(level: String) {
        bakeCustomAnnotations()
        guard let data = pdf.dataRepresentation() else { return }
        guard let url = Panels.save(title: "壓縮檔案大小", suggestedName: "\(baseName)-壓縮.pdf") else { return }
        let password = security?.userPassword
        let before = data.count
        Task { @MainActor in
            let workspace = Workspace.shared
            workspace.beginProgress("正在壓縮…", total: 1)
            defer { workspace.endProgress() }
            do {
                let out = try await PDFEngineBridge.shared.compress(in: data, password: password, level: level)
                try out.write(to: url, options: .atomic)
                Workspace.shared.noteRecent(url)
                let formatter = ByteCountFormatter()
                let saved = before > 0 ? Int((1 - Double(out.count) / Double(before)) * 100) : 0
                Panels.showMessage(
                    title: "壓縮完成",
                    message: "已儲存至「\(url.lastPathComponent)」。\n壓縮前約 \(formatter.string(fromByteCount: Int64(before)))，壓縮後 \(formatter.string(fromByteCount: Int64(out.count)))（縮小約 \(max(0, saved))%）"
                )
            } catch {
                Panels.showError(error, title: "壓縮失敗")
            }
        }
    }

    /// 移除密碼與權限限制，另存沒有加密的版本（文件必須已能開啟）。
    func removeSecurity() {
        bakeCustomAnnotations()
        guard let url = Panels.save(title: "移除密碼與限制", suggestedName: "\(baseName)-無密碼.pdf") else { return }
        do {
            try ExportService.write(pdf, to: url, security: nil)
            Workspace.shared.noteRecent(url)
            Panels.showMessage(title: "已移除密碼與限制", message: "已另存沒有密碼、沒有權限限制的版本至「\(url.lastPathComponent)」。")
        } catch {
            Panels.showError(error, title: "無法移除密碼")
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
        UserDefaults.standard.set(language.rawValue, forKey: Self.ocrLanguageKey)

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

    // MARK: - 擷取圖片與移除空白頁

    /// 擷取頁面中的圖片（PNG），存到選擇的資料夾。
    func extractImages() {
        bakeCustomAnnotations()
        guard let data = pdf.dataRepresentation() else { return }
        let password = security?.userPassword
        Task { @MainActor in
            let workspace = Workspace.shared
            workspace.beginProgress("正在擷取圖片…", total: 1)
            let images: [Data]
            do {
                images = try await PDFEngineBridge.shared.extractImages(in: data, password: password)
            } catch {
                workspace.endProgress()
                Panels.showError(error, title: "擷取圖片失敗")
                return
            }
            workspace.endProgress()
            guard !images.isEmpty else {
                Panels.showMessage(title: "沒有可擷取的圖片", message: "這份文件的頁面中找不到內嵌圖片。")
                return
            }
            guard let folder = Panels.chooseFolder(title: "選擇要存放圖片的資料夾") else { return }
            let digits = String(images.count).count
            do {
                for (index, image) in images.enumerated() {
                    let name = String(format: "%0\(digits)d", index + 1)
                    try image.write(to: folder.appendingPathComponent("\(baseName)-圖片\(name).png"))
                }
                Panels.showMessage(title: "已擷取圖片", message: "已擷取 \(images.count) 張圖片到「\(folder.lastPathComponent)」。")
            } catch {
                Panels.showError(error, title: "儲存圖片失敗")
            }
        }
    }

    /// 偵測並移除空白頁（看起來幾乎全白、且沒有註解的頁面）；不會移除唯一一頁。
    func removeBlankPages() {
        var blanks: [Int] = []
        for index in 0..<pdf.pageCount {
            guard let page = pdf.page(at: index) else { continue }
            if page.annotations.isEmpty, Self.isBlankPage(page) { blanks.append(index) }
        }
        if blanks.count >= pdf.pageCount { blanks.removeLast() }
        guard !blanks.isEmpty else {
            Panels.showMessage(title: "沒有空白頁", message: "找不到可移除的空白頁（含註解的頁面不算空白）。")
            return
        }
        let count = blanks.count
        deletePages(blanks)
        Panels.showMessage(title: "已移除空白頁", message: "已移除 \(count) 個空白頁。")
    }

    /// 頁面是否幾乎全白（低解析度渲染後，深色像素比例極低）。
    private static func isBlankPage(_ page: PDFPage) -> Bool {
        guard let image = PageRenderer.image(for: page, dpi: 18) else { return false }
        let width = image.width
        let height = image.height
        guard width > 0, height > 0 else { return false }
        var pixels = [UInt8](repeating: 0, count: width * height)
        guard let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        var dark = 0
        for value in pixels where value < 240 { dark += 1 }
        return Double(dark) / Double(width * height) < 0.001
    }

    /// 設定文件中繼資料（標題、作者、主旨、關鍵字）。
    func setMetadata(title: String, author: String, subject: String, keywords: String) {
        var attributes = pdf.documentAttributes ?? [:]
        attributes[PDFDocumentAttribute.titleAttribute] = title
        attributes[PDFDocumentAttribute.authorAttribute] = author
        attributes[PDFDocumentAttribute.subjectAttribute] = subject
        let list = keywords.split(whereSeparator: { $0 == "," || $0 == "，" }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        attributes[PDFDocumentAttribute.keywordsAttribute] = list
        pdf.documentAttributes = attributes
        markChanged()
    }
}
