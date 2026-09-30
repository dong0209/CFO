import AppKit
import CoreText

/// PDF 引擎辨識出的字型與候選清單（見 PDFEditorWindows/src/engine/fonts.ts）。
public struct FontRequest: Sendable, Equatable {
    public struct Candidate: Sendable, Equatable {
        public let family: String
        /// true：與原字型相同；false：相近的替代字型
        public let exact: Bool

        public init(family: String, exact: Bool) {
            self.family = family
            self.exact = exact
        }
    }

    /// 主要字型缺字時（例如英文字型遇到中文）使用的中文備援字型
    public struct Fallback: Sendable, Equatable {
        public let system: [Candidate]
        public let downloads: [Candidate]

        public init(system: [Candidate], downloads: [Candidate]) {
            self.system = system
            self.downloads = downloads
        }
    }

    public let originalName: String
    public let family: String
    /// CSS 字重 100–900
    public var weight: Int
    public var italic: Bool
    public let system: [Candidate]
    public let downloads: [Candidate]
    public let fallback: Fallback?

    public init(originalName: String, family: String, weight: Int, italic: Bool, system: [Candidate], downloads: [Candidate], fallback: Fallback? = nil) {
        self.originalName = originalName
        self.family = family
        self.weight = weight
        self.italic = italic
        self.system = system
        self.downloads = downloads
        self.fallback = fallback
    }

    init?(_ d: [String: Any]) {
        func candidates(_ value: Any?) -> [Candidate] {
            (value as? [[String: Any]] ?? []).compactMap { item in
                (item["family"] as? String).map { Candidate(family: $0, exact: item["exact"] as? Bool ?? false) }
            }
        }
        guard let originalName = d["originalName"] as? String, let family = d["family"] as? String else { return nil }
        let fallback = (d["fallback"] as? [String: Any]).map { Fallback(system: candidates($0["system"]), downloads: candidates($0["downloads"])) }
        self.init(
            originalName: originalName,
            family: family,
            weight: (d["weight"] as? NSNumber)?.intValue ?? 400,
            italic: d["italic"] as? Bool ?? false,
            system: candidates(d["system"]),
            downloads: candidates(d["downloads"]),
            fallback: fallback
        )
    }

    /// 使用者手動選擇的字型（電腦上的或可下載的）。
    public static func chosen(family: String, weight: Int, italic: Bool, downloadable: Bool) -> FontRequest {
        let candidate = [Candidate(family: family, exact: true)]
        let isCJK = family.range(of: #"(TC|SC|JP|KR|HK|CJK)\b|Hei|Ming|Song|Kai|Mincho|Gothic|PingFang|[\u3400-\u9fff]"#, options: .regularExpression) != nil
        return FontRequest(
            originalName: family,
            family: family,
            weight: weight,
            italic: italic,
            system: downloadable ? [] : candidate,
            downloads: downloadable ? candidate : [],
            fallback: isCJK ? nil : Fallback(
                system: ["PingFang TC", "Heiti TC", "Microsoft JhengHei"].map { Candidate(family: $0, exact: false) },
                downloads: [Candidate(family: "Noto Sans TC", exact: false)]
            )
        )
    }
}

/// 字型選單的選擇：自動（依原字型辨識）、Mac 上的字型、或可自動下載的開源字型。
public enum FontChoice: Hashable, Sendable {
    case auto
    case system(String)
    case download(String)

    public var family: String? {
        switch self {
        case .auto: return nil
        case .system(let name), .download(let name): return name
        }
    }
}

/// 找到的字型檔。
public struct ResolvedFont: Sendable {
    public enum Source: String, Sendable {
        case system
        case download
    }

    public let data: Data
    /// 字型集合（.ttc）中的第幾個字型
    public let index: Int
    public let name: String
    public let source: Source
    public let exact: Bool
    /// 下載的字型檔位置（快取）
    public var url: URL?

    public init(data: Data, index: Int, name: String, source: Source, exact: Bool, url: URL? = nil) {
        self.data = data
        self.index = index
        self.name = name
        self.source = source
        self.exact = exact
        self.url = url
    }

    public var sourceDescription: String { source == .system ? "Mac 上的字型" : "已下載" }

    /// 以這個字型建立指定大小的 NSFont（用於編輯框預覽）。
    public func nsFont(size: CGFloat) -> NSFont? {
        guard let descriptors = CTFontManagerCreateFontDescriptorsFromData(data as CFData) as? [CTFontDescriptor],
              descriptors.indices.contains(index) else { return nil }
        return CTFontCreateWithFontDescriptor(descriptors[index], size, nil) as NSFont
    }
}

/// 找字型：先找 Mac 上已安裝的字型，再從 Google Fonts 下載並快取在「應用程式支援」資料夾。
public actor FontResolver {
    public static let shared = FontResolver()

    private var failedDownloads: Set<String> = []
    private let session: URLSession
    private let cacheDirectory: URL

    public init(session: URLSession = .shared, cacheDirectory: URL? = nil) {
        self.session = session
        self.cacheDirectory = cacheDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PDFEditor/Fonts", isDirectory: true)
    }

    public func resolve(_ request: FontRequest) async -> ResolvedFont? {
        for candidate in request.system {
            if let font = await Self.systemFont(named: candidate.family, weight: request.weight, italic: request.italic) {
                return ResolvedFont(data: font.data, index: font.index, name: font.name, source: .system, exact: candidate.exact)
            }
        }
        for candidate in request.downloads {
            if let downloaded = await download(family: candidate.family, weight: request.weight, italic: request.italic) {
                let style = downloaded.weight >= 700 ? " Bold" : downloaded.weight != 400 ? " \(downloaded.weight)" : ""
                return ResolvedFont(data: downloaded.data, index: 0, name: candidate.family + style, source: .download, exact: candidate.exact, url: downloaded.url)
            }
        }
        return nil
    }

    /// 依字型選單的選擇找出字型；自動時使用 `autoRequest`（原字型辨識結果）並套用粗體／斜體。
    public func resolve(choice: FontChoice, bold: Bool, italic: Bool, autoRequest: FontRequest?) async -> (font: ResolvedFont?, request: FontRequest?) {
        var request: FontRequest?
        switch choice {
        case .auto:
            request = autoRequest
            if var adjusted = request {
                if bold, adjusted.weight < 600 { adjusted.weight = 700 }
                if !bold, adjusted.weight >= 600 { adjusted.weight = 400 }
                adjusted.italic = italic
                request = adjusted
            }
        case .system(let family):
            request = .chosen(family: family, weight: bold ? 700 : 400, italic: italic, downloadable: false)
        case .download(let family):
            request = .chosen(family: family, weight: bold ? 700 : 400, italic: italic, downloadable: true)
        }
        guard let request else { return (nil, nil) }
        return (await resolve(request), request)
    }

    /// 新文字含有中日韓文字、而字型可能缺字時，另外找一個中文備援字型。
    public func resolveFallback(for request: FontRequest?, text: String) async -> ResolvedFont? {
        guard let fallback = request?.fallback,
              text.range(of: #"[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]"#, options: .regularExpression) != nil else { return nil }
        return await resolve(FontRequest(originalName: request?.originalName ?? "", family: fallback.system.first?.family ?? "", weight: request?.weight ?? 400, italic: false, system: fallback.system, downloads: fallback.downloads))
    }

    /// 下載的開源字型註冊給本程式使用（文字方塊以 PDFKit 顯示時需要）。
    public static func register(_ font: ResolvedFont) -> NSFont? {
        if let url = font.url {
            var error: Unmanaged<CFError>?
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error)
        }
        return font.nsFont(size: 12)
    }

    /// 啟動時註冊先前下載過的字型，讓含有這些字型的文字方塊能正常顯示。
    public nonisolated func registerCachedFonts() {
        let files = (try? FileManager.default.contentsOfDirectory(at: cacheDirectory, includingPropertiesForKeys: nil)) ?? []
        for file in files where file.pathExtension.lowercased() == "ttf" {
            var error: Unmanaged<CFError>?
            CTFontManagerRegisterFontsForURL(file as CFURL, .process, &error)
        }
    }

    /// 可從 Google Fonts 下載的常用開源字型（與 Windows 版相同）。
    public static let downloadableFamilies = [
        "Noto Sans TC", "Noto Serif TC", "LXGW WenKai TC", "Noto Sans SC", "Noto Serif SC", "Noto Sans JP", "Noto Serif JP", "Noto Sans KR",
        "Roboto", "Open Sans", "Lato", "Montserrat", "Inter", "Source Sans 3", "Arimo", "Tinos", "Cousine", "Carlito", "Caladea",
        "Merriweather", "Playfair Display", "EB Garamond", "Roboto Mono", "Source Code Pro",
    ]

    // MARK: - 已安裝的字型

    /// CSS 字重轉為 NSFontManager 的 0–15 字重。
    static func appKitWeight(_ cssWeight: Int) -> Int {
        switch cssWeight {
        case ..<150: return 2
        case ..<250: return 3
        case ..<350: return 4
        case ..<450: return 5
        case ..<550: return 6
        case ..<650: return 8
        case ..<750: return 9
        case ..<850: return 10
        default: return 11
        }
    }

    private static func normalize(_ text: String) -> String {
        text.lowercased().filter { !" _-,.".contains($0) }
    }

    /// 依 PostScript 名稱、全名或字族找已安裝的字型，回傳字型檔資料與集合索引。
    @MainActor
    static func systemFont(named name: String, weight: Int, italic: Bool) -> (data: Data, index: Int, name: String)? {
        let key = normalize(name)
        guard !key.isEmpty else { return nil }
        var font: NSFont?
        if let exact = NSFont(name: name, size: 12), normalize(exact.fontName) == key || normalize(exact.displayName ?? "") == key {
            font = exact
        } else {
            let traits: NSFontTraitMask = italic ? .italicFontMask : []
            let family = NSFontManager.shared.availableFontFamilies.first { normalize($0) == key || normalize(FontCatalog.displayName(of: $0)) == key }
            if let family {
                font = NSFontManager.shared.font(withFamily: family, traits: traits, weight: appKitWeight(weight), size: 12)
                    ?? NSFontManager.shared.font(withFamily: family, traits: [], weight: appKitWeight(weight), size: 12)
            }
        }
        guard let font,
              let url = CTFontCopyAttribute(font as CTFont, kCTFontURLAttribute) as? URL,
              let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return nil }
        var index = 0
        if let descriptors = CTFontManagerCreateFontDescriptorsFromData(data as CFData) as? [CTFontDescriptor], descriptors.count > 1 {
            index = descriptors.firstIndex { (CTFontDescriptorCopyAttribute($0, kCTFontNameAttribute) as? String) == font.fontName } ?? 0
        }
        return (data, index, font.displayName ?? font.fontName)
    }

    // MARK: - Google Fonts

    static func cssURL(family: String, weight: Int, italic: Bool) -> URL? {
        let name = family.addingPercentEncoding(withAllowedCharacters: .alphanumerics)?.replacingOccurrences(of: "%20", with: "+") ?? family
        let query = italic ? "\(name):ital,wght@1,\(weight)" : "\(name):wght@\(weight)"
        return URL(string: "https://fonts.googleapis.com/css2?family=\(query)")
    }

    static func fontURL(fromCSS css: String) -> URL? {
        guard let regex = try? NSRegularExpression(pattern: #"src:\s*url\((https://fonts\.gstatic\.com/[^)]+)\)\s*format\('truetype'\)"#),
              let match = regex.firstMatch(in: css, range: NSRange(css.startIndex..., in: css)),
              let range = Range(match.range(at: 1), in: css) else { return nil }
        return URL(string: String(css[range]))
    }

    private func download(family: String, weight: Int, italic: Bool) async -> (data: Data, weight: Int, url: URL)? {
        let safe = family.replacingOccurrences(of: "[^A-Za-z0-9 -]", with: "", options: .regularExpression).replacingOccurrences(of: " ", with: "-")
        let attempts: [(Int, Bool)] = [(weight, italic), (weight, false), (400, italic), (400, false), (700, false)]
        for (w, i) in attempts {
            let file = cacheDirectory.appendingPathComponent("\(safe)-\(w)\(i ? "i" : "").ttf")
            if let data = try? Data(contentsOf: file) { return (data, w, file) }
            let key = "\(family)|\(w)|\(i)"
            if failedDownloads.contains(key) { continue }
            do {
                guard let cssURL = Self.cssURL(family: family, weight: w, italic: i) else { throw URLError(.badURL) }
                var request = URLRequest(url: cssURL)
                // 非瀏覽器的 User-Agent 會取得完整的 TTF 字型檔
                request.setValue("PDFEditor/1.0", forHTTPHeaderField: "User-Agent")
                let (cssData, response) = try await session.data(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      let fontURL = Self.fontURL(fromCSS: String(decoding: cssData, as: UTF8.self)) else { throw URLError(.fileDoesNotExist) }
                let (fontData, fontResponse) = try await session.data(from: fontURL)
                guard (fontResponse as? HTTPURLResponse)?.statusCode == 200, !fontData.isEmpty else { throw URLError(.badServerResponse) }
                try FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
                try fontData.write(to: file, options: .atomic)
                return (fontData, w, file)
            } catch {
                failedDownloads.insert(key)
            }
        }
        return nil
    }
}
