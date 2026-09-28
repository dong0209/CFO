// 產生 App 圖示（AppIcon.iconset），由 build-app.sh 呼叫後再以 iconutil 轉成 .icns。
import AppKit

let output = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset")
try? FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

func drawIcon(size: CGFloat) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = size / 1024

    // 背景
    let background = NSBezierPath(roundedRect: NSRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s), xRadius: 185 * s, yRadius: 185 * s)
    NSGradient(starting: NSColor(calibratedRed: 0.93, green: 0.27, blue: 0.23, alpha: 1), ending: NSColor(calibratedRed: 0.72, green: 0.10, blue: 0.16, alpha: 1))!.draw(in: background, angle: -90)

    // 紙張
    let paper = NSBezierPath()
    paper.move(to: NSPoint(x: 290 * s, y: 220 * s))
    paper.line(to: NSPoint(x: 734 * s, y: 220 * s))
    paper.line(to: NSPoint(x: 734 * s, y: 690 * s))
    paper.line(to: NSPoint(x: 604 * s, y: 820 * s))
    paper.line(to: NSPoint(x: 290 * s, y: 820 * s))
    paper.close()
    NSColor.white.setFill()
    paper.fill()
    let fold = NSBezierPath()
    fold.move(to: NSPoint(x: 604 * s, y: 820 * s))
    fold.line(to: NSPoint(x: 604 * s, y: 690 * s))
    fold.line(to: NSPoint(x: 734 * s, y: 690 * s))
    fold.close()
    NSColor(white: 0.85, alpha: 1).setFill()
    fold.fill()

    // 文字與筆
    let attributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 150 * s, weight: .heavy),
        .foregroundColor: NSColor(calibratedRed: 0.80, green: 0.15, blue: 0.18, alpha: 1),
    ]
    let text = NSAttributedString(string: "PDF", attributes: attributes)
    let textSize = text.size()
    text.draw(at: NSPoint(x: 512 * s - textSize.width / 2, y: 330 * s))
    NSColor(white: 0.75, alpha: 1).setFill()
    for i in 0..<3 {
        NSBezierPath(roundedRect: NSRect(x: 350 * s, y: (600 + CGFloat(i) * 55) * s, width: (i == 2 ? 200 : 300) * s, height: 22 * s), xRadius: 11 * s, yRadius: 11 * s).fill()
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep
}

for (points, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)] {
    let pixels = CGFloat(points * scale)
    let name = scale == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png"
    let data = drawIcon(size: pixels).representation(using: .png, properties: [:])!
    try! data.write(to: output.appendingPathComponent(name))
}
