import AppKit
import PDFEditorCore
import PDFKit
import SwiftUI

/// 批次處理：對整個資料夾的 PDF 執行同一項操作，輸出到輸出資料夾下新建的子資料夾。
struct BatchSheet: View {
    @ObservedObject var workspace = Workspace.shared
    @Environment(\.dismiss) private var dismiss

    enum Operation: String, CaseIterable, Identifiable {
        case removeSecurity, compress, watermark, pageNumbers, images
        var id: String { rawValue }
        var title: String {
            switch self {
            case .removeSecurity: return "移除密碼與限制"
            case .compress: return "壓縮檔案大小"
            case .watermark: return "加入浮水印"
            case .pageNumbers: return "加入頁碼"
            case .images: return "轉為圖片"
            }
        }
    }

    @State private var sourceFolder: URL?
    @State private var files: [URL] = []
    @State private var outputRoot: URL?
    @State private var operation: Operation = .removeSecurity
    @State private var level = "medium"
    @State private var watermarkText = "機密"
    @State private var template = "{n} / {total}"
    @State private var imageFormat: ImageExportFormat = .png
    @State private var dpi: Double = 150
    @State private var running = false

    private var ready: Bool {
        !files.isEmpty && outputRoot != nil && (operation != .watermark || !watermarkText.trimmingCharacters(in: .whitespaces).isEmpty) && !running
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("批次處理").font(.title2.bold())

            HStack {
                Text("來源資料夾").frame(width: 90, alignment: .leading)
                Button(sourceFolder?.lastPathComponent ?? "選擇資料夾…") { pickSource() }
                if sourceFolder != nil {
                    Text("找到 \(files.count) 個 PDF").font(.caption).foregroundStyle(.secondary)
                }
            }

            Picker("操作", selection: $operation) {
                ForEach(Operation.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.radioGroup)

            switch operation {
            case .compress:
                Picker("壓縮強度", selection: $level) {
                    Text("低（畫質優先）").tag("low")
                    Text("中（平衡）").tag("medium")
                    Text("高（檔案最小）").tag("high")
                }
            case .watermark:
                TextField("浮水印文字", text: $watermarkText)
            case .pageNumbers:
                TextField("頁碼樣板（{n}、{total}）", text: $template)
            case .images:
                Picker("格式", selection: $imageFormat) {
                    Text("PNG").tag(ImageExportFormat.png)
                    Text("JPEG").tag(ImageExportFormat.jpeg)
                }
                HStack {
                    Text("解析度")
                    Slider(value: $dpi, in: 72...600, step: 1).frame(width: 180)
                    Text("\(Int(dpi)) dpi").monospacedDigit()
                }
            case .removeSecurity:
                Text("輸出沒有密碼、沒有權限限制的版本（受密碼保護而打不開的檔案會略過）。")
                    .font(.caption).foregroundStyle(.secondary)
            }

            HStack {
                Text("輸出到").frame(width: 90, alignment: .leading)
                Button(outputRoot?.lastPathComponent ?? "選擇資料夾…") { if let url = Panels.chooseFolder(title: "選擇輸出資料夾") { outputRoot = url } }
            }
            Text("結果會存到輸出資料夾下新建的子資料夾，不會覆蓋原始檔案。")
                .font(.caption).foregroundStyle(.secondary)

            HStack {
                Spacer()
                Button("取消") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("開始處理") {
                    Task { await run() }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(!ready)
            }
        }
        .padding(20)
        .frame(width: 520)
    }

    private func pickSource() {
        guard let folder = Panels.chooseFolder(title: "選擇要批次處理的資料夾") else { return }
        sourceFolder = folder
        files = ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension.lowercased() == "pdf" }
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
        if outputRoot == nil { outputRoot = folder }
    }

    @MainActor
    private func run() async {
        guard let outputRoot, !files.isEmpty else { return }
        running = true
        defer { running = false }
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmm"
        let outDir = outputRoot.appendingPathComponent("\(operation.title) \(formatter.string(from: Date()))")
        do {
            try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        } catch {
            Panels.showError(error, title: "無法建立輸出資料夾")
            return
        }

        var ok = 0, skipped = 0, failed = 0
        var problems: [String] = []
        workspace.beginProgress("批次處理中…", total: files.count)
        for (index, url) in files.enumerated() {
            workspace.updateProgress(index)
            let name = url.lastPathComponent
            let stem = url.deletingPathExtension().lastPathComponent
            guard let doc = PDFDocument(url: url) else {
                failed += 1
                problems.append("\(name)：無法開啟")
                continue
            }
            if doc.isLocked {
                skipped += 1
                problems.append("\(name)：需要密碼，已略過")
                continue
            }
            do {
                switch operation {
                case .removeSecurity:
                    try ExportService.write(doc, to: outDir.appendingPathComponent("\(stem).pdf"), security: nil)
                case .compress:
                    guard let data = doc.dataRepresentation() else { throw ExportError.writeFailed(url) }
                    let out = try await PDFEngineBridge.shared.compress(in: data, password: nil, level: level)
                    try out.write(to: outDir.appendingPathComponent("\(stem).pdf"), options: .atomic)
                case .watermark:
                    for i in 0..<doc.pageCount {
                        guard let page = doc.page(at: i) else { continue }
                        page.addAnnotation(WatermarkAnnotation(pageBounds: page.bounds(for: .cropBox), text: watermarkText, fontSize: 60, color: .systemRed, opacity: 0.25, angle: 45))
                    }
                    bakeAndWrite(doc, to: outDir.appendingPathComponent("\(stem).pdf"))
                case .pageNumbers:
                    let total = doc.pageCount
                    for i in 0..<doc.pageCount {
                        guard let page = doc.page(at: i) else { continue }
                        let text = PageNumberFormat.render(template, page: i + 1, total: total)
                        page.addAnnotation(TextStampAnnotation(pageBounds: page.bounds(for: .cropBox), text: text, fontSize: 10, color: .labelColor, position: .bottomCenter, margin: 28))
                    }
                    bakeAndWrite(doc, to: outDir.appendingPathComponent("\(stem).pdf"))
                case .images:
                    _ = try ExportService.exportImages(from: doc, pageIndices: Array(0..<doc.pageCount), to: outDir, baseName: stem, format: imageFormat, dpi: CGFloat(dpi))
                }
                ok += 1
            } catch {
                failed += 1
                problems.append("\(name)：\(error.localizedDescription)")
            }
        }
        workspace.endProgress()
        dismiss()

        var lines = ["完成 \(ok) 個檔案，已存到「\(outDir.lastPathComponent)」資料夾。"]
        if skipped > 0 { lines.append("略過 \(skipped) 個（需要密碼）") }
        if failed > 0 { lines.append("失敗 \(failed) 個") }
        if !problems.isEmpty { lines.append(""); lines.append(contentsOf: problems.prefix(12)) }
        Panels.showMessage(title: "批次處理結果", message: lines.joined(separator: "\n"))
    }

    private func bakeAndWrite(_ doc: PDFDocument, to url: URL) {
        let replacements = PageOperations.pages(of: doc).compactMap(PageFlattener.bakeCustomAnnotations)
        replacements.forEach { $0.apply(in: doc) }
        try? ExportService.write(doc, to: url, security: nil)
    }
}
