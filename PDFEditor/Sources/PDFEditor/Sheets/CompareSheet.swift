import PDFKit
import SwiftUI

/// 並排比較兩份開啟中的文件（唯讀）。
struct CompareSheet: View {
    @ObservedObject var workspace = Workspace.shared
    @Environment(\.dismiss) private var dismiss
    @State private var leftID: EditorDocument.ID?
    @State private var rightID: EditorDocument.ID?

    private var documents: [EditorDocument] { workspace.documents }
    private func document(_ id: EditorDocument.ID?) -> EditorDocument? { documents.first { $0.id == id } }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text("並排比較").font(.headline)
                documentPicker(selection: $leftID)
                Image(systemName: "arrow.left.and.right").foregroundStyle(.secondary)
                documentPicker(selection: $rightID)
                Spacer()
                Button("關閉") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(10)
            Divider()
            HStack(spacing: 0) {
                pane(for: leftID)
                Divider()
                pane(for: rightID)
            }
        }
        .frame(minWidth: 960, minHeight: 640)
        .onAppear {
            if leftID == nil { leftID = workspace.current?.id ?? documents.first?.id }
            if rightID == nil { rightID = documents.first(where: { $0.id != leftID })?.id ?? documents.dropFirst().first?.id }
        }
    }

    private func documentPicker(selection: Binding<EditorDocument.ID?>) -> some View {
        Picker("", selection: selection) {
            ForEach(documents) { doc in
                Text(doc.displayName).tag(Optional(doc.id))
            }
        }
        .labelsHidden()
        .frame(maxWidth: 260)
    }

    @ViewBuilder
    private func pane(for id: EditorDocument.ID?) -> some View {
        if let doc = document(id) {
            ComparePDFView(document: doc.pdf)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            Color(nsColor: .windowBackgroundColor)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// 以 PDFView 唯讀顯示一份文件（連續捲動、自動縮放）。
private struct ComparePDFView: NSViewRepresentable {
    let document: PDFDocument

    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.displayMode = .singlePageContinuous
        view.displaysPageBreaks = true
        view.autoScales = true
        view.document = document
        return view
    }

    func updateNSView(_ view: PDFView, context: Context) {
        if view.document !== document {
            view.document = document
            view.autoScales = true
        }
    }
}
