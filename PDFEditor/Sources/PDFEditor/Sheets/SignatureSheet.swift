import AppKit
import SwiftUI

/// 儲存於「應用程式支援」資料夾的常用簽名。
@MainActor
final class SignatureStore: ObservableObject {
    static let shared = SignatureStore()

    struct Signature: Identifiable {
        let id: URL
        let image: CGImage
    }

    @Published private(set) var signatures: [Signature] = []

    private var folder: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("PDFEditor/Signatures", isDirectory: true)
    }

    private init() {
        reload()
    }

    func reload() {
        let urls = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.creationDateKey])) ?? []
        signatures = urls
            .filter { $0.pathExtension.lowercased() == "png" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .compactMap { url in
                guard let image = NSImage(contentsOf: url)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
                return Signature(id: url, image: image)
            }
    }

    func add(_ image: CGImage) {
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let rep = NSBitmapImageRep(cgImage: image)
            guard let data = rep.representation(using: .png, properties: [:]) else { return }
            let name = "signature-\(Int(Date().timeIntervalSince1970 * 1000)).png"
            try data.write(to: folder.appendingPathComponent(name))
            reload()
        } catch {
            Panels.showError(error, title: "無法儲存簽名")
        }
    }

    func delete(_ signature: Signature) {
        try? FileManager.default.removeItem(at: signature.id)
        reload()
    }
}

struct SignatureSheet: View {
    @ObservedObject private var store = SignatureStore.shared
    @Environment(\.dismiss) private var dismiss
    @State private var strokes: [[CGPoint]] = []
    @State private var currentStroke: [CGPoint] = []
    @State private var inkColor: Color = .black
    @State private var inkWidth: CGFloat = 3

    private let padSize = CGSize(width: 520, height: 200)

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("簽名").font(.title2.bold())

            if !store.signatures.isEmpty {
                Text("選擇已儲存的簽名，然後在頁面上點一下放置：")
                    .foregroundStyle(.secondary)
                ScrollView(.horizontal) {
                    HStack(spacing: 12) {
                        ForEach(store.signatures) { signature in
                            Button {
                                use(signature.image)
                            } label: {
                                Image(decorative: signature.image, scale: 3)
                                    .resizable()
                                    .aspectRatio(contentMode: .fit)
                                    .frame(width: 160, height: 70)
                                    .padding(6)
                                    .background(Color.white, in: RoundedRectangle(cornerRadius: 8))
                                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.4)))
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button("刪除簽名", role: .destructive) { store.delete(signature) }
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
                Divider()
            }

            Text("新增簽名：在下方框內用滑鼠或觸控板書寫")
                .foregroundStyle(.secondary)

            ZStack {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.white)
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color.secondary.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [6, 4]))
                Path { path in
                    path.move(to: CGPoint(x: 30, y: padSize.height - 40))
                    path.addLine(to: CGPoint(x: padSize.width - 30, y: padSize.height - 40))
                }
                .stroke(Color.gray.opacity(0.4), lineWidth: 1)
                StrokesShape(strokes: strokes + [currentStroke])
                    .stroke(inkColor, style: StrokeStyle(lineWidth: inkWidth, lineCap: .round, lineJoin: .round))
            }
            .frame(width: padSize.width, height: padSize.height)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .local)
                    .onChanged { value in currentStroke.append(value.location) }
                    .onEnded { _ in
                        if currentStroke.count == 1, let point = currentStroke.first {
                            currentStroke.append(CGPoint(x: point.x + 0.5, y: point.y + 0.5))
                        }
                        strokes.append(currentStroke)
                        currentStroke = []
                    }
            )

            HStack {
                ColorPicker("顏色", selection: $inkColor, supportsOpacity: false)
                Picker("粗細", selection: $inkWidth) {
                    Text("細").tag(CGFloat(2))
                    Text("中").tag(CGFloat(3))
                    Text("粗").tag(CGFloat(5))
                }
                .pickerStyle(.segmented)
                .frame(width: 160)
                Button("清除") { strokes = [] }
                    .disabled(strokes.isEmpty)
                Spacer()
                Button("匯入圖片…") { importImage() }
            }

            HStack {
                Spacer()
                Button("取消") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("儲存並使用") {
                    if let image = renderSignature() {
                        store.add(image)
                        use(image)
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(strokes.isEmpty)
            }
        }
        .padding(20)
    }

    private func use(_ image: CGImage) {
        ToolState.shared.arm(image: image, as: .signature)
        dismiss()
    }

    private func importImage() {
        guard let url = Panels.openImages(multiple: false, title: "選擇簽名圖片（建議使用透明背景 PNG）").first,
              let image = NSImage(contentsOf: url)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
        store.add(image)
    }

    /// 將筆畫裁切到實際範圍後，以 3 倍解析度輸出透明背景圖片。
    private func renderSignature() -> CGImage? {
        let points = strokes.flatMap { $0 }
        guard let minX = points.map(\.x).min(), let maxX = points.map(\.x).max(),
              let minY = points.map(\.y).min(), let maxY = points.map(\.y).max() else { return nil }
        let padding = inkWidth * 2
        let origin = CGPoint(x: minX - padding, y: minY - padding)
        let size = CGSize(width: maxX - minX + padding * 2, height: maxY - minY + padding * 2)
        let shifted = strokes.map { stroke in stroke.map { CGPoint(x: $0.x - origin.x, y: $0.y - origin.y) } }

        let renderer = ImageRenderer(
            content: StrokesShape(strokes: shifted)
                .stroke(inkColor, style: StrokeStyle(lineWidth: inkWidth, lineCap: .round, lineJoin: .round))
                .frame(width: size.width, height: size.height)
        )
        renderer.scale = 3
        return renderer.cgImage
    }
}

private struct StrokesShape: Shape {
    let strokes: [[CGPoint]]

    func path(in rect: CGRect) -> Path {
        var path = Path()
        for stroke in strokes {
            guard let first = stroke.first else { continue }
            path.move(to: first)
            for point in stroke.dropFirst() {
                path.addLine(to: point)
            }
        }
        return path
    }
}
