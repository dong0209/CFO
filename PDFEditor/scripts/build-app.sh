#!/bin/bash
# 編譯並打包成 PDFEditor.app 與 PDFEditor.dmg（需在 macOS 上執行，需 Xcode 或 Command Line Tools）。
#
# 用法：./scripts/build-app.sh [版本號]
# 環境變數 UNIVERSAL=1 會同時編譯 Apple Silicon 與 Intel（需要完整 Xcode）。
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="${1:-1.0.0}"
BUILD_NUMBER="${BUILD_NUMBER:-$(date +%Y%m%d%H%M)}"
OUT="build"
APP="$OUT/PDFEditor.app"

ARCH_FLAGS=()
if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  ARCH_FLAGS=(--arch arm64 --arch x86_64)
fi

echo "▸ 編譯（release）"
swift build -c release "${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"}"
BIN_DIR="$(swift build -c release "${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"}" --show-bin-path)"

echo "▸ 建立 App 套件"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/PDFEditor" "$APP/Contents/MacOS/PDFEditor"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD_NUMBER/" Resources/Info.plist > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "▸ 產生圖示"
ICONSET="$OUT/AppIcon.iconset"
rm -rf "$ICONSET"
swift scripts/make-icon.swift "$ICONSET"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

echo "▸ 簽章（ad-hoc）"
codesign --force --deep --sign - "$APP"

echo "▸ 建立 DMG"
DMG_DIR="$OUT/dmg"
rm -rf "$DMG_DIR" "$OUT/PDFEditor.dmg"
mkdir -p "$DMG_DIR"
cp -R "$APP" "$DMG_DIR/"
ln -s /Applications "$DMG_DIR/Applications"
hdiutil create -volname "PDF 編輯器" -srcfolder "$DMG_DIR" -ov -format UDZO "$OUT/PDFEditor.dmg" >/dev/null
rm -rf "$DMG_DIR"

echo "✓ 完成：$APP"
echo "✓ 完成：$OUT/PDFEditor.dmg"
