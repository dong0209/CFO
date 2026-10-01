import PDFKit

public extension PDFAnnotation {
    /// `type` 回傳的名稱不含斜線（例如 `Highlight`），而 `PDFAnnotationSubtype.rawValue` 含斜線（`/Highlight`），
    /// 統一轉成 `PDFAnnotationSubtype` 以便比較。
    var subtype: PDFAnnotationSubtype {
        let name = type ?? ""
        return PDFAnnotationSubtype(rawValue: name.hasPrefix("/") ? name : "/" + name)
    }

    func isType(_ subtypes: PDFAnnotationSubtype...) -> Bool {
        subtypes.contains(subtype)
    }
}
