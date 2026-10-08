import AppKit
import UniformTypeIdentifiers
import WebKit

/// 影像編輯用的整頁影像。
public struct EditorPageImage: Sendable {
    /// PNG（不含註解）
    public let png: Data
    /// 頁面大小（點）
    public let width: CGFloat
    public let height: CGFloat
}

/// 影像編輯模式：以 WKWebView 顯示與 Windows 版相同的影像編輯器（PDFEditorWindows/src/imageEditor），
/// 在文件視窗上以工作表（sheet）開啟，完成後回傳編輯結果。
@MainActor
public final class ImageEditorSession: NSObject {
    private let page: EditorPageImage
    private let title: String
    private var window: NSWindow?
    private var webView: WKWebView?
    private var continuation: CheckedContinuation<[String: Any]?, Never>?
    /// 編輯期間保留自己（WKWebView 只弱參照訊息處理者）
    private var keepAlive: ImageEditorSession?

    public init(page: EditorPageImage, title: String) {
        self.page = page
        self.title = title
    }

    /// 影像編輯器的網頁位置（與 PDF 引擎一起打包在 Engine/image-editor）。
    public static var editorDirectory: URL? {
        guard let engine = PDFEngineBridge.engineDirectory else { return nil }
        let directory = engine.appendingPathComponent("image-editor")
        return FileManager.default.fileExists(atPath: directory.appendingPathComponent("index.html").path) ? directory : nil
    }

    /// 顯示編輯器，完成時回傳結果（取消為 nil）。結果中的影像以 base64 字串表示，文字物件帶有字型選擇（choice）。
    public func run(over parent: NSWindow?) async throws -> [String: Any]? {
        guard let directory = Self.editorDirectory else { throw PDFEngineError.resourcesMissing }
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(EngineSchemeHandler(root: directory), forURLScheme: EngineSchemeHandler.scheme)
        configuration.userContentController.add(WeakMessageHandler(self), name: "host")
        let frame = parent.map { $0.frame.insetBy(dx: 24, dy: 24) } ?? CGRect(x: 0, y: 0, width: 1280, height: 860)
        let size = CGSize(width: max(frame.width, 960), height: max(frame.height, 640))
        let webView = WKWebView(frame: CGRect(origin: .zero, size: size), configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.title = title
        window.contentView = webView
        window.contentMinSize = CGSize(width: 900, height: 600)
        self.webView = webView
        self.window = window
        keepAlive = self
        webView.load(URLRequest(url: URL(string: "\(EngineSchemeHandler.scheme)://editor/index.html")!))
        if let parent {
            parent.beginSheet(window)
        } else {
            window.center()
            window.makeKeyAndOrderFront(nil)
        }
        window.makeFirstResponder(webView)
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    private func finish(_ result: [String: Any]?) {
        if let window {
            if let parent = window.sheetParent {
                parent.endSheet(window)
            } else {
                window.orderOut(nil)
            }
        }
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "host")
        webView = nil
        window = nil
        continuation?.resume(returning: result)
        continuation = nil
        keepAlive = nil
    }

    // MARK: - 與網頁溝通

    private func reply(_ id: Int?, _ value: Any?, error: String? = nil) {
        guard let id, let webView else { return }
        Task { @MainActor in
            _ = try? await webView.callAsyncJavaScript(
                "window.__hostReply(id, value, error);",
                arguments: ["id": id, "value": value ?? NSNull(), "error": error ?? NSNull()],
                contentWorld: .page
            )
        }
    }

    private func handle(_ body: Any) {
        guard let message = body as? [String: Any], let type = message["type"] as? String else { return }
        let id = (message["id"] as? NSNumber)?.intValue
        switch type {
        case "ready":
            guard let webView else { return }
            let arguments: [String: Any] = [
                "page": [
                    "png": page.png.base64EncodedString(),
                    "width": Double(page.width),
                    "height": Double(page.height),
                    "title": title,
                ] as [String: Any],
            ]
            Task { @MainActor in
                _ = try? await webView.callAsyncJavaScript("window.imageEditor.open(page);", arguments: arguments, contentWorld: .page)
            }

        case "listFonts":
            let families = FontCatalog.allFamilies()
            let preferred = ["PingFang TC", "Heiti TC", "Songti TC"].first { name in families.contains { $0.name == name } }
            let defaultChoice: [String: Any] = preferred.map { ["kind": "system", "family": $0] } ?? ["kind": "download", "family": "Noto Sans TC"]
            reply(id, [
                "families": families.map { family -> [String: Any] in
                    ["family": family.name, "label": family.displayName == family.name ? family.name : "\(family.displayName)（\(family.name)）"]
                },
                "downloadable": FontResolver.downloadableFamilies,
                "defaultChoice": defaultChoice,
            ] as [String: Any])

        case "fontData":
            let choice = message["choice"] as? [String: Any]
            let family = choice?["family"] as? String ?? ""
            let bold = message["bold"] as? Bool ?? false
            let italic = message["italic"] as? Bool ?? false
            Task { @MainActor in
                let resolved = await FontResolver.shared.resolve(choice: .download(family), bold: bold, italic: italic, autoRequest: nil)
                // 下載的字型一律是單一字型檔（index 0），可直接給網頁預覽
                let data: String? = resolved.font.flatMap { $0.index == 0 ? $0.data.base64EncodedString() : nil }
                self.reply(id, data)
            }

        case "pickImage":
            pickImage { [weak self] data in
                self?.reply(id, data?.base64EncodedString())
            }

        case "done":
            finish(message["result"] as? [String: Any])

        default:
            reply(id, nil, error: "未知的要求：\(type)")
        }
    }

    private func pickImage(_ completion: @escaping (Data?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        panel.message = "選擇要插入的圖片"
        let handler: (NSApplication.ModalResponse) -> Void = { response in
            guard response == .OK, let url = panel.url else {
                completion(nil)
                return
            }
            completion(Self.pngOrJPEG(contentsOf: url))
        }
        if let window {
            panel.beginSheetModal(for: window, completionHandler: handler)
        } else {
            handler(panel.runModal())
        }
    }

    /// PDF 引擎可直接使用 PNG 與 JPEG；其他格式（HEIC、TIFF 等）轉成 PNG。
    nonisolated static func pngOrJPEG(contentsOf url: URL) -> Data? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let type = UTType(filenameExtension: url.pathExtension)
        if type?.conforms(to: .png) == true || type?.conforms(to: .jpeg) == true { return data }
        guard let rep = NSBitmapImageRep(data: data) ?? NSImage(data: data)?.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }

    // MARK: - 套用

    /// 把編輯器的結果轉成 PDF 引擎的格式：base64 轉回資料，並為文字物件找到字型檔（含中文備援字型）。
    public static func prepareEdit(_ result: [String: Any], resolver: FontResolver = .shared) async -> [String: Any] {
        var edit = result
        edit["background"] = (result["background"] as? String).flatMap { Data(base64Encoded: $0) } ?? NSNull()
        var objects: [[String: Any]] = []
        for var object in result["objects"] as? [[String: Any]] ?? [] {
            switch object["type"] as? String {
            case "image":
                object["data"] = (object["data"] as? String).flatMap { Data(base64Encoded: $0) } ?? Data()
            case "text":
                if let choice = object["choice"] as? [String: Any], let family = choice["family"] as? String {
                    let fontChoice: FontChoice = (choice["kind"] as? String) == "download" ? .download(family) : .system(family)
                    let bold = object["bold"] as? Bool ?? false
                    let italic = object["italic"] as? Bool ?? false
                    let resolved = await resolver.resolve(choice: fontChoice, bold: bold, italic: italic, autoRequest: nil)
                    let fallback = await resolver.resolveFallback(for: resolved.request, text: object["text"] as? String ?? "")
                    if let font = resolved.font { object["font"] = ["data": font.data, "index": font.index] as [String: Any] }
                    if let fallback { object["fallbackFont"] = ["data": fallback.data, "index": fallback.index] as [String: Any] }
                    object["family"] = family
                }
                object.removeValue(forKey: "choice")
            default:
                break
            }
            objects.append(object)
        }
        edit["objects"] = objects
        return edit
    }
}

extension ImageEditorSession: WKScriptMessageHandler {
    public nonisolated func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            handle(message.body)
        }
    }
}
