import AppKit
import PDFEditorCore
import PDFKit
import SwiftUI

/// 已安裝的字型清單（第一次使用時讀取）。
enum FontLists {
    static let grouped = FontCatalog.groupedFamilies()
}

/// 字族選單：常用字型在前，其他字型依名稱排序。
struct FontFamilyPicker: View {
    @Binding var family: String

    private var isListed: Bool {
        FontLists.grouped.recommended.contains { $0.name == family } || FontLists.grouped.others.contains { $0.name == family }
    }

    var body: some View {
        Picker("字型", selection: $family) {
            if !isListed {
                Text(FontCatalog.displayName(of: family)).tag(family)
            }
            Section("常用字型") {
                ForEach(FontLists.grouped.recommended) { Text($0.displayName).tag($0.name) }
            }
            Section("所有字型") {
                ForEach(FontLists.grouped.others) { Text($0.displayName).tag($0.name) }
            }
        }
        .help("字型")
    }
}

/// 樣式選單（一般、粗體、斜體…），依字族提供的樣式列出。
struct FontFacePicker: View {
    let family: String
    @Binding var face: String?

    var body: some View {
        let faces = FontCatalog.faces(of: family)
        let selection = Binding<String>(
            get: { face ?? FontCatalog.regularFace(of: family)?.postScriptName ?? "" },
            set: { face = $0 }
        )
        Picker("樣式", selection: selection) {
            if faces.isEmpty {
                Text("一般").tag("")
            }
            ForEach(faces) { Text($0.displayName).tag($0.postScriptName) }
        }
        .disabled(faces.count < 2)
        .help("字型樣式")
    }
}

/// 新增或編輯文字方塊：內容、字型、樣式、字級、顏色與預覽。
struct TextBoxSheet: View {
    let request: TextBoxRequest
    @ObservedObject var document: EditorDocument
    @Environment(\.dismiss) private var dismiss

    @State private var text: String
    @State private var family: String
    @State private var face: String?
    @State private var size: Double
    @State private var color: Color

    init(request: TextBoxRequest, document: EditorDocument) {
        self.request = request
        self.document = document
        let tools = ToolState.shared
        if let annotation = request.annotation, let font = annotation.font {
            _text = State(initialValue: annotation.contents ?? "")
            _family = State(initialValue: font.familyName ?? FontCatalog.defaultFamily)
            _face = State(initialValue: font.fontName)
            _size = State(initialValue: Double(font.pointSize))
            _color = State(initialValue: Color(nsColor: annotation.fontColor ?? .black))
        } else {
            _text = State(initialValue: request.annotation?.contents ?? "")
            _family = State(initialValue: tools.fontFamily)
            _face = State(initialValue: tools.fontFace)
            _size = State(initialValue: Double(tools.fontSize))
            _color = State(initialValue: tools.color)
        }
    }

    private var isEditing: Bool { request.annotation != nil }
    private var font: NSFont { FontCatalog.font(family: family, face: face, size: CGFloat(size)) }
    private var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(isEditing ? "編輯文字" : "新增文字").font(.title2.bold())

            TextEditor(text: $text)
                .font(.system(size: 14))
                .frame(height: 100)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.35)))

            HStack(spacing: 12) {
                FontFamilyPicker(family: $family)
                    .frame(width: 260)
                FontFacePicker(family: family, face: $face)
                    .labelsHidden()
                    .frame(width: 150)
            }

            HStack(spacing: 12) {
                Text("字級")
                Slider(value: $size, in: 6...96, step: 1)
                    .frame(width: 170)
                TextField("", value: $size, format: .number)
                    .frame(width: 48)
                    .multilineTextAlignment(.trailing)
                Stepper("", value: $size, in: 6...96, step: 1)
                    .labelsHidden()
                Spacer()
                ColorPicker("顏色", selection: $color, supportsOpacity: false)
            }

            Text("預覽").font(.caption).foregroundStyle(.secondary)
            ScrollView {
                Text(isEmpty ? "預覽文字 Preview 123" : text)
                    .font(Font(font as CTFont))
                    .foregroundStyle(isEmpty ? color.opacity(0.4) : color)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
            .frame(height: 120)
            .background(Color.white)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.35)))

            HStack {
                Text("⌘↩ \(isEditing ? "套用" : "加入")").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("取消") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(isEditing ? "套用" : "加入") { commit() }
                    .keyboardShortcut(.return, modifiers: .command)
                    .buttonStyle(.borderedProminent)
                    .disabled(isEmpty)
            }
        }
        .padding(20)
        .frame(width: 560)
        .onChange(of: family) { newFamily in
            face = FontCatalog.regularFace(of: newFamily)?.postScriptName
        }
    }

    private func commit() {
        guard !isEmpty else { return }
        let font = self.font
        let nsColor = NSColor(color)
        if let annotation = request.annotation {
            document.restyleTextBox(annotation, text: text, font: font, color: nsColor)
        } else if let point = request.point {
            document.addTextBox(text, font: font, color: nsColor, at: point, on: request.page)
        }
        ToolState.shared.rememberTextStyle(family: family, face: face, size: CGFloat(size), color: nsColor)
        dismiss()
    }
}
