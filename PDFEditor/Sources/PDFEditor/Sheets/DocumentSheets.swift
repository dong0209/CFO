import PDFEditorCore
import SwiftUI

/// 對話框共用外框：標題、內容與底部按鈕。
struct SheetContainer<Content: View>: View {
    let title: String
    let confirmTitle: String
    let canConfirm: Bool
    let onConfirm: () -> Void
    let content: Content
    @Environment(\.dismiss) private var dismiss

    init(title: String, confirmTitle: String, canConfirm: Bool, onConfirm: @escaping () -> Void, @ViewBuilder content: () -> Content) {
        self.title = title
        self.confirmTitle = confirmTitle
        self.canConfirm = canConfirm
        self.onConfirm = onConfirm
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title).font(.title2.bold())
            Form { content }
                .formStyle(.grouped)
                .scrollDisabled(true)
            HStack {
                Spacer()
                Button("取消") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(confirmTitle) {
                    dismiss()
                    // 等對話框關閉後再執行，避免與開檔面板等互相干擾。
                    DispatchQueue.main.async { onConfirm() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canConfirm)
            }
        }
        .padding(20)
        .frame(width: 460)
    }
}

/// 頁面範圍選擇：全部、目前／選取的頁面、自訂範圍。
struct PageScopePicker: View {
    enum Scope: String, CaseIterable, Identifiable {
        case all, selected, custom
        var id: String { rawValue }
        var title: String {
            switch self {
            case .all: return "全部頁面"
            case .selected: return "目前／選取的頁面"
            case .custom: return "自訂範圍"
            }
        }
    }

    @Binding var scope: Scope
    @Binding var customRange: String
    let pageCount: Int

    var body: some View {
        Picker("套用頁面", selection: $scope) {
            ForEach(Scope.allCases) { Text($0.title).tag($0) }
        }
        if scope == .custom {
            TextField("頁碼範圍", text: $customRange, prompt: Text("例如 1-3, 5, 8-"))
            if !customRange.isEmpty, PageOperations.parsePageRanges(customRange, pageCount: pageCount) == nil {
                Text("範圍格式錯誤或超出頁數（共 \(pageCount) 頁）")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    static func indices(scope: Scope, customRange: String, document: EditorDocument) -> [Int]? {
        switch scope {
        case .all: return Array(0..<document.pageCount)
        case .selected: return document.targetPageIndices
        case .custom:
            return PageOperations.parsePageRanges(customRange, pageCount: document.pageCount).map(PageOperations.indices(from:))
        }
    }
}

// MARK: - 浮水印

struct WatermarkSheet: View {
    @ObservedObject var document: EditorDocument
    @State private var text = "機密"
    @State private var fontSize: Double = 72
    @State private var opacity: Double = 0.25
    @State private var angle: Double = 45
    @State private var color: Color = .red
    @State private var scope: PageScopePicker.Scope = .all
    @State private var customRange = ""

    private var indices: [Int]? { PageScopePicker.indices(scope: scope, customRange: customRange, document: document) }

    var body: some View {
        SheetContainer(title: "加入浮水印", confirmTitle: "加入", canConfirm: !text.isEmpty && indices?.isEmpty == false) {
            document.addWatermark(text: text, fontSize: fontSize, color: NSColor(color), opacity: opacity, angle: angle, pageIndices: indices ?? [])
        } content: {
            TextField("文字", text: $text)
            LabeledSlider(title: "字級", value: $fontSize, range: 12...200, format: "%.0f")
            LabeledSlider(title: "不透明度", value: $opacity, range: 0.05...1, format: "%.0f%%", multiplier: 100)
            LabeledSlider(title: "角度", value: $angle, range: -90...90, format: "%.0f°")
            ColorPicker("顏色", selection: $color, supportsOpacity: false)
            PageScopePicker(scope: $scope, customRange: $customRange, pageCount: document.pageCount)
        }
    }
}

struct LabeledSlider: View {
    let title: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    let format: String
    var multiplier: Double = 1

    var body: some View {
        HStack {
            Slider(value: $value, in: range) { Text(title) }
            Text(String(format: format, value * multiplier))
                .monospacedDigit()
                .frame(width: 48, alignment: .trailing)
        }
    }
}

// MARK: - 頁碼、頁首頁尾

struct PageNumberSheet: View {
    @ObservedObject var document: EditorDocument
    @State private var template = "第 {n} 頁，共 {total} 頁"
    @State private var startAt = 1
    @State private var position: StampPosition = .bottomCenter
    @State private var fontSize: Double = 10
    @State private var margin: Double = 28
    @State private var color: Color = .black
    @State private var scope: PageScopePicker.Scope = .all
    @State private var customRange = ""

    private var indices: [Int]? { PageScopePicker.indices(scope: scope, customRange: customRange, document: document) }

    var body: some View {
        SheetContainer(title: "頁碼與頁首頁尾", confirmTitle: "加入", canConfirm: !template.isEmpty && indices?.isEmpty == false) {
            document.addPageNumbers(template: template, startAt: startAt, position: position, fontSize: fontSize, color: NSColor(color), margin: margin, pageIndices: indices ?? [])
        } content: {
            TextField("內容", text: $template)
            Picker("常用格式", selection: $template) {
                ForEach(PageNumberFormat.presets, id: \.self) { Text($0).tag($0) }
                if !PageNumberFormat.presets.contains(template) {
                    Text("自訂").tag(template)
                }
            }
            Text("可用 {n} 代表頁碼、{total} 代表總頁數；不含這些符號即為一般頁首頁尾文字。預覽：\(PageNumberFormat.render(template, page: startAt, total: document.pageCount + startAt - 1))")
                .font(.caption)
                .foregroundStyle(.secondary)
            Stepper("起始頁碼：\(startAt)", value: $startAt, in: 0...9999)
            Picker("位置", selection: $position) {
                ForEach(StampPosition.allCases) { Text($0.title).tag($0) }
            }
            LabeledSlider(title: "字級", value: $fontSize, range: 6...36, format: "%.0f")
            LabeledSlider(title: "邊界", value: $margin, range: 8...96, format: "%.0f pt")
            ColorPicker("顏色", selection: $color, supportsOpacity: false)
            PageScopePicker(scope: $scope, customRange: $customRange, pageCount: document.pageCount)
        }
    }
}

// MARK: - 密碼

struct PasswordSheet: View {
    @ObservedObject var document: EditorDocument
    @State private var requireOpenPassword = true
    @State private var userPassword = ""
    @State private var confirmPassword = ""
    @State private var ownerPassword = ""
    @Environment(\.dismiss) private var dismiss

    private var isValid: Bool {
        if requireOpenPassword {
            return !userPassword.isEmpty && userPassword == confirmPassword
        }
        return !ownerPassword.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SheetContainer(title: "密碼保護", confirmTitle: "套用", canConfirm: isValid) {
                document.security = SecurityOptions(
                    userPassword: requireOpenPassword ? userPassword : nil,
                    ownerPassword: ownerPassword.isEmpty ? nil : ownerPassword
                )
                document.markChanged()
            } content: {
                Toggle("開啟文件時需要密碼", isOn: $requireOpenPassword)
                if requireOpenPassword {
                    SecureField("開啟密碼", text: $userPassword)
                    SecureField("確認密碼", text: $confirmPassword)
                    if !confirmPassword.isEmpty, userPassword != confirmPassword {
                        Text("兩次輸入的密碼不一致").font(.caption).foregroundStyle(.red)
                    }
                }
                SecureField("擁有者（權限）密碼（選填）", text: $ownerPassword)
                Text("密碼會在下次儲存時套用，使用 AES 加密。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if document.security != nil || document.pdf.isEncrypted {
                Button("移除密碼保護", role: .destructive) {
                    document.security = nil
                    document.markChanged()
                    dismiss()
                }
                .padding([.horizontal, .bottom], 20)
            }
        }
    }
}

// MARK: - 分割

struct SplitSheet: View {
    enum Mode: String, CaseIterable, Identifiable {
        case everyN, ranges
        var id: String { rawValue }
    }

    @ObservedObject var document: EditorDocument
    @State private var mode: Mode = .everyN
    @State private var pagesPerFile = 1
    @State private var ranges = ""

    private var parsedRanges: [ClosedRange<Int>]? { PageOperations.parsePageRanges(ranges, pageCount: document.pageCount) }

    var body: some View {
        SheetContainer(title: "分割 PDF", confirmTitle: "選擇資料夾並分割", canConfirm: mode == .everyN || parsedRanges != nil) {
            document.split(ranges: mode == .ranges ? parsedRanges : nil, every: pagesPerFile)
        } content: {
            Picker("分割方式", selection: $mode) {
                Text("每隔固定頁數").tag(Mode.everyN)
                Text("依頁碼範圍").tag(Mode.ranges)
            }
            .pickerStyle(.radioGroup)
            if mode == .everyN {
                Stepper("每 \(pagesPerFile) 頁一個檔案", value: $pagesPerFile, in: 1...max(1, document.pageCount))
                Text("將產生 \((document.pageCount + pagesPerFile - 1) / pagesPerFile) 個檔案")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                TextField("範圍", text: $ranges, prompt: Text("例如 1-3, 4-6, 7-"))
                Text(parsedRanges.map { "將產生 \($0.count) 個檔案，每個範圍一個" } ?? "以逗號分隔範圍（共 \(document.pageCount) 頁）")
                    .font(.caption)
                    .foregroundStyle(parsedRanges == nil && !ranges.isEmpty ? Color.red : Color.secondary)
            }
        }
    }
}

// MARK: - 匯出圖片

struct ExportImagesSheet: View {
    @ObservedObject var document: EditorDocument
    @State private var format: ImageExportFormat = .png
    @State private var dpi: Double = 150
    @State private var scope: PageScopePicker.Scope = .all
    @State private var customRange = ""

    private var indices: [Int]? { PageScopePicker.indices(scope: scope, customRange: customRange, document: document) }

    var body: some View {
        SheetContainer(title: "匯出為圖片", confirmTitle: "選擇資料夾並匯出", canConfirm: indices?.isEmpty == false) {
            document.exportImages(pageIndices: indices ?? [], format: format, dpi: dpi)
        } content: {
            Picker("格式", selection: $format) {
                ForEach(ImageExportFormat.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            Picker("解析度", selection: $dpi) {
                Text("72 dpi（螢幕）").tag(72.0)
                Text("150 dpi（一般）").tag(150.0)
                Text("300 dpi（列印）").tag(300.0)
                Text("600 dpi（高品質）").tag(600.0)
            }
            PageScopePicker(scope: $scope, customRange: $customRange, pageCount: document.pageCount)
        }
    }
}

// MARK: - OCR

struct OCRSheet: View {
    @ObservedObject var document: EditorDocument
    @State private var language: OCRService.Language = .traditionalChinese
    @State private var onlyWithoutText = true

    var body: some View {
        SheetContainer(title: "文字辨識（OCR）", confirmTitle: "開始辨識", canConfirm: true) {
            document.runOCR(language: language, onlyPagesWithoutText: onlyWithoutText)
        } content: {
            Picker("語言", selection: $language) {
                ForEach(OCRService.Language.allCases) { Text($0.title).tag($0) }
            }
            Toggle("只處理沒有文字的頁面（掃描頁）", isOn: $onlyWithoutText)
            Text("使用 macOS 內建的文字辨識，所有處理都在本機完成。辨識後的頁面會加入隱形文字層，可搜尋、選取與複製；頁面外觀不變。")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
