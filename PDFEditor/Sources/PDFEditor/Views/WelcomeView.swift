import SwiftUI

struct WelcomeView: View {
    @ObservedObject var workspace = Workspace.shared

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 20) {
                Image(systemName: "doc.richtext.fill")
                    .font(.system(size: 64))
                    .foregroundStyle(.tint)
                Text("PDF 編輯器")
                    .font(.largeTitle.bold())
                Text("將 PDF 或圖片拖曳到這裡即可開啟")
                    .foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 10) {
                    WelcomeButton(title: "開啟 PDF…", symbol: "folder", shortcut: "⌘O") { workspace.showOpenPanel() }
                    WelcomeButton(title: "新增空白文件", symbol: "doc.badge.plus", shortcut: "⌘N") { workspace.newBlankDocument() }
                    WelcomeButton(title: "從圖片建立 PDF…", symbol: "photo.on.rectangle", shortcut: nil) { workspace.showCreateFromImagesPanel() }
                    WelcomeButton(title: "合併多個 PDF…", symbol: "doc.on.doc", shortcut: nil) { workspace.showMergePanel() }
                }
                .frame(width: 280)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if !workspace.recentURLs.isEmpty {
                Divider()
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text("最近開啟").font(.headline)
                        Spacer()
                        Button("清除") { workspace.clearRecent() }
                            .buttonStyle(.borderless)
                    }
                    .padding(12)
                    List(workspace.recentURLs, id: \.self) { url in
                        Button {
                            workspace.open([url])
                        } label: {
                            HStack {
                                Image(nsImage: NSWorkspace.shared.icon(forFile: url.path))
                                    .resizable()
                                    .frame(width: 28, height: 28)
                                VStack(alignment: .leading) {
                                    Text(url.lastPathComponent).lineLimit(1)
                                    Text(url.deletingLastPathComponent().path)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    .listStyle(.sidebar)
                }
                .frame(width: 300)
            }
        }
    }
}

private struct WelcomeButton: View {
    let title: String
    let symbol: String
    let shortcut: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Image(systemName: symbol).frame(width: 24)
                Text(title)
                Spacer()
                if let shortcut {
                    Text(shortcut).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
    }
}
