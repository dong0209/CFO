import AppKit
import WebKit

/// 可直接編輯的文字行（座標為 PDF 使用者座標，與 PDFKit 的頁面座標相同）。
public struct EditableTextLine: Sendable, Equatable {
    public let index: Int
    public let text: String
    public let bounds: CGRect
    public let baseline: CGPoint
    public let fontName: String
    public let fontSize: CGFloat
    public let isBold: Bool
    public let isItalic: Bool
    public let isSerif: Bool
    public let isMonospaced: Bool
    /// sRGB，0–1
    public let color: [CGFloat]
    /// 原字型是否內嵌在 PDF 中
    public let hasEmbeddedFont: Bool
    /// 原文是否可正確辨識（false 時 PDF 缺少字元對照表，應重新輸入整行）
    public let isTextReliable: Bool
    /// OCR 辨識出的隱形文字（看得見的字形在掃描影像中；套用時會把影像中的原字改成背景色）
    public let isOCR: Bool

    public var nsColor: NSColor {
        NSColor(srgbRed: color[safe: 0] ?? 0, green: color[safe: 1] ?? 0, blue: color[safe: 2] ?? 0, alpha: 1)
    }

    /// 編輯框使用的近似字型（中文會自動以系統中文字型顯示）。
    public func displayFont(scale: CGFloat) -> NSFont {
        let size = max(fontSize * scale, 4)
        let base: NSFont
        if isMonospaced {
            base = NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
        } else if isSerif {
            base = NSFont(name: "Times New Roman", size: size) ?? NSFont.systemFont(ofSize: size)
        } else {
            base = NSFont(name: "Helvetica", size: size) ?? NSFont.systemFont(ofSize: size)
        }
        var traits: NSFontTraitMask = []
        if isBold { traits.insert(.boldFontMask) }
        if isItalic { traits.insert(.italicFontMask) }
        return traits.isEmpty ? base : NSFontManager.shared.convert(base, toHaveTrait: traits)
    }
}

/// 修改文字時的字型與樣式設定。
public struct TextEditOptions: Sendable {
    /// Mac 上的或下載的字型
    public var font: ResolvedFont?
    /// 主要字型缺字時使用的字型（例如英文字型遇到中文）
    public var fallbackFont: ResolvedFont?
    /// 使用者自選字型：不沿用原檔字型
    public var forceFont = false
    public var size: CGFloat?
    /// sRGB，0–1
    public var color: [CGFloat]?
    public var bold: Bool?
    public var italic: Bool?

    public init(font: ResolvedFont? = nil, fallbackFont: ResolvedFont? = nil, forceFont: Bool = false, size: CGFloat? = nil, color: [CGFloat]? = nil, bold: Bool? = nil, italic: Bool? = nil) {
        self.font = font
        self.fallbackFont = fallbackFont
        self.forceFont = forceFont
        self.size = size
        self.color = color
        self.bold = bold
        self.italic = italic
    }

    var dictionary: [String: Any] {
        var override: [String: Any] = [:]
        if let size { override["size"] = Double(size) }
        if let color { override["color"] = color.map(Double.init) }
        if let bold { override["bold"] = bold }
        if let italic { override["italic"] = italic }
        var result: [String: Any] = ["override": override, "forceFont": forceFont]
        if let font { result["font"] = ["data": font.data, "index": font.index] as [String: Any] }
        if let fallbackFont { result["fallbackFont"] = ["data": fallbackFont.data, "index": fallbackFont.index] as [String: Any] }
        return result
    }
}

public enum PDFEngineError: LocalizedError {
    case resourcesMissing
    case loadFailed(String)
    case scriptFailed(String)
    case invalidResponse(String)
    case passwordRequired

    public var errorDescription: String? {
        switch self {
        case .resourcesMissing: return "找不到文字編輯引擎（Engine 資料夾）。請使用完整打包的 App。"
        case .loadFailed(let message): return "無法載入文字編輯引擎：\(message)"
        case .scriptFailed(let message): return message
        case .invalidResponse(let method): return "文字編輯引擎回傳了無法辨識的資料（\(method)）"
        case .passwordRequired: return "這份文件受密碼保護，無法編輯文字"
        }
    }
}

/// 以隱藏的 WKWebView 執行與 Windows 版相同的 MuPDF 引擎，提供 PDFKit 做不到的「直接修改原有文字」。
@MainActor
public final class PDFEngineBridge: NSObject {
    public static let shared = PDFEngineBridge()

    private var webView: WKWebView?
    private var isReady = false
    private var waiters: [CheckedContinuation<Void, Error>] = []
    private var loadError: Error?

    /// 引擎資源位置：環境變數 → App 內的 Resources/Engine → 開發時的 PDFEditorWindows/dist-mac-engine。
    public static var engineDirectory: URL? {
        let fileManager = FileManager.default
        var candidates: [URL] = []
        if let path = ProcessInfo.processInfo.environment["PDFEDITOR_ENGINE_DIR"] {
            candidates.append(URL(fileURLWithPath: path))
        }
        if let resources = Bundle.main.resourceURL {
            candidates.append(resources.appendingPathComponent("Engine"))
        }
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<6 {
            candidates.append(directory.appendingPathComponent("PDFEditorWindows/dist-mac-engine"))
            directory.deleteLastPathComponent()
        }
        return candidates.first { fileManager.fileExists(atPath: $0.appendingPathComponent("index.html").path) }
    }

    private func start() throws {
        guard webView == nil else { return }
        guard let directory = Self.engineDirectory else { throw PDFEngineError.resourcesMissing }
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(EngineSchemeHandler(root: directory), forURLScheme: EngineSchemeHandler.scheme)
        configuration.userContentController.add(WeakMessageHandler(self), name: "engineReady")
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 10, height: 10), configuration: configuration)
        webView.navigationDelegate = self
        self.webView = webView
        webView.load(URLRequest(url: URL(string: "\(EngineSchemeHandler.scheme)://engine/index.html")!))
    }

    private func waitUntilReady() async throws {
        if isReady { return }
        if let loadError { throw loadError }
        try start()
        try await withCheckedThrowingContinuation { continuation in
            waiters.append(continuation)
        }
    }

    private func finishLoading(_ error: Error?) {
        if let error {
            loadError = error
            webView = nil
        } else {
            isReady = true
        }
        let pending = waiters
        waiters = []
        for waiter in pending {
            if let error {
                waiter.resume(throwing: error)
            } else {
                waiter.resume()
            }
        }
    }

    /// 呼叫引擎方法；`Data` 參數與回傳值自動以 base64 轉換。
    public func call(_ method: String, _ arguments: [Any]) async throws -> Any? {
        try await waitUntilReady()
        guard let webView else { throw PDFEngineError.loadFailed("WebView 已釋放") }
        let encoded = arguments.map(Self.encode)
        do {
            let result = try await webView.callAsyncJavaScript(
                "return window.pdfEngine.call(method, args);",
                arguments: ["method": method, "args": encoded],
                contentWorld: .page
            )
            return Self.decode(result)
        } catch {
            let message = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription
            throw PDFEngineError.scriptFailed(message.replacingOccurrences(of: "Error: ", with: ""))
        }
    }

    private static func encode(_ value: Any) -> Any {
        switch value {
        case let data as Data: return ["__b64": data.base64EncodedString()]
        case let point as CGPoint: return [Double(point.x), Double(point.y)]
        case let array as [Any]: return array.map(encode)
        case let dictionary as [String: Any]: return dictionary.mapValues(encode)
        default: return value
        }
    }

    private static func decode(_ value: Any?) -> Any? {
        switch value {
        case let dictionary as [String: Any]:
            if let base64 = dictionary["__b64"] as? String { return Data(base64Encoded: base64) }
            return dictionary.mapValues { decode($0) as Any }
        case let array as [Any]:
            return array.map { decode($0) as Any }
        default:
            return value
        }
    }

    // MARK: - 直接編輯文字

    /// 開啟文件資料並在完成後關閉（引擎中的文件只在這次操作期間存在）。
    public func withDocument<T>(_ data: Data, password: String?, _ body: (Int) async throws -> T) async throws -> T {
        guard let opened = try await call("open", [data]) as? [String: Any],
              let id = (opened["id"] as? NSNumber)?.intValue else { throw PDFEngineError.invalidResponse("open") }
        if (opened["needsPassword"] as? Bool) == true {
            let unlocked = try await call("unlock", [id, password ?? ""]) as? Bool
            if unlocked != true {
                _ = try? await call("close", [id])
                throw PDFEngineError.passwordRequired
            }
        }
        do {
            let result = try await body(id)
            _ = try? await call("close", [id])
            return result
        } catch {
            _ = try? await call("close", [id])
            throw error
        }
    }

    /// 找出頁面上包含某點（PDF 使用者座標）的文字行。
    public func textLine(document id: Int, page: Int, at point: CGPoint) async throws -> EditableTextLine? {
        let value = try await call("textLineAtUserPoint", [id, page, point])
        guard let dictionary = value as? [String: Any] else { return nil }
        return try Self.makeLine(dictionary)
    }

    /// 以新文字取代一行；回傳實際使用的字型來源（embedded／supplied／mixed／standard）。
    @discardableResult
    public func replaceTextLine(document id: Int, page: Int, line: Int, with text: String, options: TextEditOptions = TextEditOptions()) async throws -> String {
        let result = try await call("replaceTextLine", [id, page, line, text, options.dictionary]) as? [String: Any]
        return result?["font"] as? String ?? "standard"
    }

    /// 辨識某行的字型，回傳尋找／下載字型的候選清單。
    public func fontRequest(document id: Int, page: Int, line: Int) async throws -> FontRequest {
        guard let dictionary = try await call("fontRequest", [id, page, line]) as? [String: Any],
              let request = FontRequest(dictionary) else { throw PDFEngineError.invalidResponse("fontRequest") }
        return request
    }

    public func save(document id: Int) async throws -> Data {
        guard let data = try await call("save", [id, [String: Any]()]) as? Data else { throw PDFEngineError.invalidResponse("save") }
        return data
    }

    /// 一次完成：讀取點選位置的文字行。
    public func textLine(in data: Data, password: String?, page: Int, at point: CGPoint) async throws -> EditableTextLine? {
        try await withDocument(data, password: password) { id in
            try await textLine(document: id, page: page, at: point)
        }
    }

    /// 一次完成：讀取點選位置的文字行與字型候選清單。
    public func textLineWithFont(in data: Data, password: String?, page: Int, at point: CGPoint) async throws -> (EditableTextLine, FontRequest)? {
        try await withDocument(data, password: password) { id in
            guard let line = try await textLine(document: id, page: page, at: point) else { return nil }
            return (line, try await fontRequest(document: id, page: page, line: line.index))
        }
    }

    /// 一次完成：以新文字取代某一行，回傳新的 PDF 資料與實際使用的字型來源。
    public func replacingTextLine(in data: Data, password: String?, page: Int, line: Int, with text: String, options: TextEditOptions = TextEditOptions()) async throws -> (data: Data, fontSource: String) {
        try await withDocument(data, password: password) { id in
            let source = try await replaceTextLine(document: id, page: page, line: line, with: text, options: options)
            return (try await save(document: id), source)
        }
    }

    private static func makeLine(_ d: [String: Any]) throws -> EditableTextLine {
        func number(_ key: String) -> CGFloat { CGFloat((d[key] as? NSNumber)?.doubleValue ?? 0) }
        func numbers(_ key: String) -> [CGFloat] { (d[key] as? [Any])?.compactMap { ($0 as? NSNumber).map { CGFloat($0.doubleValue) } } ?? [] }
        let box = numbers("userBBox")
        let origin = numbers("userOrigin")
        guard box.count == 4, origin.count == 2, let text = d["text"] as? String else {
            throw PDFEngineError.invalidResponse("textLine")
        }
        return EditableTextLine(
            index: Int(number("index")),
            text: text,
            bounds: CGRect(x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1]),
            baseline: CGPoint(x: origin[0], y: origin[1]),
            fontName: d["fontName"] as? String ?? "",
            fontSize: number("size"),
            isBold: d["bold"] as? Bool ?? false,
            isItalic: d["italic"] as? Bool ?? false,
            isSerif: d["serif"] as? Bool ?? false,
            isMonospaced: d["mono"] as? Bool ?? false,
            color: numbers("color"),
            hasEmbeddedFont: d["embeddedFont"] as? Bool ?? false,
            isTextReliable: d["textReliable"] as? Bool ?? true,
            isOCR: d["ocr"] as? Bool ?? false
        )
    }
}

extension PDFEngineBridge: WKNavigationDelegate, WKScriptMessageHandler {
    public nonisolated func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { finishLoading(nil) }
    }

    public nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        MainActor.assumeIsolated { finishLoading(PDFEngineError.loadFailed(error.localizedDescription)) }
    }

    public nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        MainActor.assumeIsolated { finishLoading(PDFEngineError.loadFailed(error.localizedDescription)) }
    }

    public nonisolated func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        MainActor.assumeIsolated {
            isReady = false
            self.webView = nil
        }
    }
}

/// 避免 WKUserContentController 強引用造成循環參考。
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

/// 以自訂網址（pdfengine://）提供引擎檔案，讓 ES 模組與 WebAssembly 能正常載入。
private final class EngineSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "pdfengine"
    let root: URL

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { return }
        let relative = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
        let file = root.appendingPathComponent(relative).standardizedFileURL
        guard file.path.hasPrefix(root.path), let data = try? Data(contentsOf: file) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let types = ["html": "text/html", "js": "text/javascript", "wasm": "application/wasm", "css": "text/css", "json": "application/json"]
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": types[file.pathExtension] ?? "application/octet-stream", "Content-Length": String(data.count)]
        )!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
