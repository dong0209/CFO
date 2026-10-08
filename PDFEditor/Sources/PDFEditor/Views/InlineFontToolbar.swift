import AppKit
import PDFEditorCore

/// 直接編輯文字時的字型設定。
struct InlineFontSettings: Equatable {
    var choice: FontChoice
    var bold: Bool
    var italic: Bool
    var size: CGFloat
    var color: NSColor
}

/// 編輯框上方的工具列：字型（自動／可下載／Mac 上的字型）、粗體、斜體、字級、顏色、套用與取消。
/// 所有控制項都不接受鍵盤焦點，操作時編輯框仍保持輸入狀態。
final class InlineFontToolbar: NSView {
    private(set) var settings: InlineFontSettings
    var onChange: ((InlineFontSettings) -> Void)?
    var onApply: (() -> Void)?
    var onCancel: (() -> Void)?

    private let familyPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let boldButton = NSButton(title: "B", target: nil, action: nil)
    private let italicButton = NSButton(title: "I", target: nil, action: nil)
    private let sizePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let colorWell = NSColorWell(frame: NSRect(x: 0, y: 0, width: 36, height: 22))
    private let stack = NSStackView()

    private static let sizes: [CGFloat] = [6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48, 60, 72, 96]

    init(settings: InlineFontSettings, autoName: String) {
        self.settings = settings
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        layer?.cornerRadius = 6
        layer?.borderWidth = 1
        layer?.borderColor = NSColor.separatorColor.cgColor
        layer?.shadowOpacity = 0.15
        layer?.shadowRadius = 4

        buildFamilyMenu(autoName: autoName)
        familyPopup.target = self
        familyPopup.action = #selector(familyChanged)
        familyPopup.controlSize = .small
        familyPopup.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        familyPopup.toolTip = "字型"
        familyPopup.widthAnchor.constraint(equalToConstant: 210).isActive = true

        for (button, title, font) in [(boldButton, "B", NSFont.boldSystemFont(ofSize: 12)), (italicButton, "I", NSFontManager.shared.convert(.systemFont(ofSize: 12), toHaveTrait: .italicFontMask))] {
            button.setButtonType(.pushOnPushOff)
            button.bezelStyle = .texturedRounded
            button.controlSize = .small
            button.attributedTitle = NSAttributedString(string: title, attributes: [.font: font])
            button.target = self
            button.action = #selector(styleChanged)
            button.widthAnchor.constraint(equalToConstant: 28).isActive = true
        }
        boldButton.toolTip = "粗體"
        italicButton.toolTip = "斜體"
        boldButton.state = settings.bold ? .on : .off
        italicButton.state = settings.italic ? .on : .off

        var sizes = Self.sizes
        if !sizes.contains(where: { abs($0 - settings.size) < 0.01 }) {
            sizes.append(settings.size)
            sizes.sort()
        }
        for size in sizes {
            sizePopup.addItem(withTitle: Self.format(size) + " pt")
            sizePopup.lastItem?.representedObject = NSNumber(value: Double(size))
        }
        sizePopup.selectItem(at: sizes.firstIndex { abs($0 - settings.size) < 0.01 } ?? 0)
        sizePopup.controlSize = .small
        sizePopup.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        sizePopup.target = self
        sizePopup.action = #selector(styleChanged)
        sizePopup.toolTip = "字級"

        colorWell.color = settings.color
        colorWell.target = self
        colorWell.action = #selector(styleChanged)
        colorWell.toolTip = "文字顏色"
        colorWell.widthAnchor.constraint(equalToConstant: 36).isActive = true
        colorWell.heightAnchor.constraint(equalToConstant: 20).isActive = true

        let apply = NSButton(title: "套用", target: self, action: #selector(applyClicked))
        apply.bezelStyle = .rounded
        apply.controlSize = .small
        apply.keyEquivalent = ""
        apply.contentTintColor = .controlAccentColor
        let cancel = NSButton(title: "取消", target: self, action: #selector(cancelClicked))
        cancel.bezelStyle = .rounded
        cancel.controlSize = .small

        for control in [familyPopup, boldButton, italicButton, sizePopup, colorWell, apply, cancel] as [NSControl] {
            control.refusesFirstResponder = true
        }

        stack.orientation = .horizontal
        stack.spacing = 6
        stack.edgeInsets = NSEdgeInsets(top: 4, left: 6, bottom: 4, right: 6)
        stack.alignment = .centerY
        for view in [familyPopup, boldButton, italicButton, sizePopup, colorWell, apply, cancel] as [NSView] {
            stack.addArrangedSubview(view)
        }
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) {
        nil
    }

    private static func format(_ size: CGFloat) -> String {
        size.rounded() == size ? String(Int(size)) : String(format: "%.1f", Double(size))
    }

    private func buildFamilyMenu(autoName: String) {
        let menu = NSMenu()
        func header(_ title: String) {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }
        func add(_ title: String, _ choice: FontChoice) {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.representedObject = ChoiceBox(choice)
            menu.addItem(item)
        }
        add("自動：\(autoName)", .auto)
        menu.addItem(.separator())
        header("可自動下載的開源字型")
        for family in FontResolver.downloadableFamilies {
            add(family, .download(family))
        }
        menu.addItem(.separator())
        header("Mac 上的字型")
        for family in FontCatalog.allFamilies() {
            add(family.displayName, .system(family.name))
        }
        familyPopup.menu = menu
        familyPopup.autoenablesItems = false
        let index = menu.items.firstIndex { ($0.representedObject as? ChoiceBox)?.choice == settings.choice } ?? 0
        familyPopup.selectItem(at: index)
    }

    @objc private func familyChanged() {
        guard let choice = (familyPopup.selectedItem?.representedObject as? ChoiceBox)?.choice else { return }
        settings.choice = choice
        onChange?(settings)
    }

    @objc private func styleChanged() {
        settings.bold = boldButton.state == .on
        settings.italic = italicButton.state == .on
        if let size = (sizePopup.selectedItem?.representedObject as? NSNumber)?.doubleValue {
            settings.size = CGFloat(size)
        }
        settings.color = colorWell.color
        onChange?(settings)
    }

    @objc private func applyClicked() {
        onApply?()
    }

    @objc private func cancelClicked() {
        onCancel?()
    }
}

/// NSMenuItem.representedObject 需要物件型別。
private final class ChoiceBox: NSObject {
    let choice: FontChoice

    init(_ choice: FontChoice) {
        self.choice = choice
    }
}
