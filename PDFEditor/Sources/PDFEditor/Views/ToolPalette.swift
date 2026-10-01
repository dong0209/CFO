import SwiftUI

/// 工具選擇與樣式設定列。
struct ToolPalette: View {
    @ObservedObject var document: EditorDocument
    @ObservedObject var tools = ToolState.shared

    private let swatches: [Color] = [.yellow, .green, .blue, .red, .orange, .purple, .black]

    var body: some View {
        HStack(spacing: 10) {
            ForEach(Array(Tool.groups.enumerated()), id: \.offset) { index, group in
                if index > 0 { Divider().frame(height: 20) }
                HStack(spacing: 2) {
                    ForEach(group) { tool in
                        ToolButton(tool: tool, isSelected: tools.tool == tool) {
                            select(tool)
                        }
                    }
                }
            }

            Divider().frame(height: 20)
            styleControls
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private func select(_ tool: Tool) {
        if tool == .signature {
            Workspace.shared.activeSheet = .signatures
        }
        if tool != tools.tool {
            tools.pendingImage = nil
        }
        tools.select(tool)
    }

    @ViewBuilder
    private var styleControls: some View {
        if tools.tool.usesColor {
            HStack(spacing: 4) {
                ForEach(swatches, id: \.self) { color in
                    Circle()
                        .fill(color)
                        .frame(width: 14, height: 14)
                        .overlay(Circle().stroke(Color.primary.opacity(0.35), lineWidth: 0.5))
                        .onTapGesture { tools.color = color }
                }
                ColorPicker("", selection: $tools.color, supportsOpacity: true)
                    .labelsHidden()
                    .help("自訂顏色")
            }
        }
        if tools.tool.usesLineWidth {
            HStack(spacing: 4) {
                Image(systemName: "lineweight").foregroundStyle(.secondary)
                Slider(value: $tools.lineWidth, in: 0.5...12)
                    .frame(width: 90)
                Text(String(format: "%.1f", tools.lineWidth))
                    .monospacedDigit()
                    .frame(width: 28)
            }
            .help("線條粗細")
        }
        if [.rectangle, .ellipse].contains(tools.tool) {
            Toggle("填色", isOn: $tools.fillShapes)
                .toggleStyle(.checkbox)
        }
        if tools.tool.usesFontSize {
            FontFamilyPicker(family: $tools.fontFamily)
                .labelsHidden()
                .frame(width: 170)
                .onChange(of: tools.fontFamily) { _ in tools.fontFace = nil }
            FontFacePicker(family: tools.fontFamily, face: $tools.fontFace)
                .labelsHidden()
                .frame(width: 100)
            Stepper(value: $tools.fontSize, in: 6...96, step: 1) {
                Text("字級 \(Int(tools.fontSize))").monospacedDigit()
            }
        }
        if tools.tool == .redact {
            Button("套用遮蓋") { document.applyRedactions() }
        }
        if tools.tool == .signature {
            Button("管理簽名…") { Workspace.shared.activeSheet = .signatures }
        }
    }
}

private struct ToolButton: View {
    let tool: Tool
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: tool.symbol)
                .font(.system(size: 14))
                .frame(width: 28, height: 24)
                .background(
                    RoundedRectangle(cornerRadius: 5)
                        .fill(isSelected ? Color.accentColor.opacity(0.25) : .clear)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(tool.title + (tool.shortcut.map { "（⌥⌘\(String($0.character).uppercased())）" } ?? ""))
    }
}
