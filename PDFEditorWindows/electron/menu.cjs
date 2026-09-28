// 繁體中文應用程式選單。選單項目以指令字串傳給畫面處理。
const { Menu } = require("electron");

const TOOLS = [
  ["select", "選取", "V"],
  ["highlight", "螢光筆", "Y"],
  ["underline", "底線", "U"],
  ["strikeout", "刪除線", "K"],
  ["note", "便利貼", "N"],
  ["textbox", "文字方塊", "B"],
  ["ink", "手繪", "P"],
  ["rectangle", "矩形", "R"],
  ["ellipse", "橢圓", "O"],
  ["line", "直線", "L"],
  ["arrow", "箭頭", "A"],
  ["whiteout", "白底遮蓋", "I"],
  ["redact", "塗黑遮蓋", "X"],
  ["image", "圖片", ""],
  ["signature", "簽名", ""],
  ["eraser", "橡皮擦", "E"],
];

function buildMenu({ send, recent, openRecent }) {
  const item = (label, command, accelerator) => ({ label, accelerator, click: () => send(command) });
  const template = [
    {
      label: "檔案(&F)",
      submenu: [
        item("新增空白文件", "new", "CmdOrCtrl+N"),
        item("開啟…", "open", "CmdOrCtrl+O"),
        {
          label: "最近開啟",
          submenu: recent.length
            ? [...recent.map((p) => ({ label: p, click: () => openRecent(p) })), { type: "separator" }, item("清除清單", "clear-recent")]
            : [{ label: "（無）", enabled: false }],
        },
        { type: "separator" },
        item("從圖片建立 PDF…", "from-images"),
        item("合併多個 PDF…", "merge"),
        { type: "separator" },
        item("儲存", "save", "CmdOrCtrl+S"),
        item("另存新檔…", "save-as", "CmdOrCtrl+Shift+S"),
        {
          label: "匯出",
          submenu: [item("匯出為圖片…", "export-images"), item("匯出文字…", "export-text"), item("匯出壓縮版本…", "export-compressed")],
        },
        item("密碼保護…", "password"),
        { type: "separator" },
        item("列印…", "print", "CmdOrCtrl+P"),
        { type: "separator" },
        item("關閉分頁", "close-tab", "CmdOrCtrl+W"),
        { label: "結束", role: "quit" },
      ],
    },
    {
      label: "編輯(&E)",
      submenu: [
        item("復原", "undo", "CmdOrCtrl+Z"),
        item("重做", "redo", "CmdOrCtrl+Y"),
        { type: "separator" },
        { label: "剪下", role: "cut" },
        { label: "複製", role: "copy" },
        { label: "貼上", role: "paste" },
        { label: "全選", role: "selectAll" },
        { type: "separator" },
        item("刪除選取的註解", "delete-annotation"),
        item("尋找…", "find", "CmdOrCtrl+F"),
        item("尋找下一個", "find-next", "F3"),
        item("尋找上一個", "find-prev", "Shift+F3"),
      ],
    },
    {
      label: "檢視(&V)",
      submenu: [
        item("顯示／隱藏側欄", "toggle-sidebar", "F4"),
        { type: "separator" },
        item("放大", "zoom-in", "CmdOrCtrl+="),
        item("縮小", "zoom-out", "CmdOrCtrl+-"),
        item("實際大小", "zoom-actual", "CmdOrCtrl+0"),
        item("符合寬度", "fit-width", "CmdOrCtrl+2"),
        item("符合頁面", "fit-page", "CmdOrCtrl+1"),
        { type: "separator" },
        item("連續捲動", "layout-continuous"),
        item("雙頁", "layout-two"),
        { type: "separator" },
        item("第一頁\tHome", "first-page"),
        item("上一頁\tPage Up", "prev-page"),
        item("下一頁\tPage Down", "next-page"),
        item("最後一頁\tEnd", "last-page"),
        item("前往頁面…", "goto-page", "CmdOrCtrl+G"),
        { type: "separator" },
        { label: "全螢幕", role: "togglefullscreen" },
        { label: "開發者工具", role: "toggleDevTools", accelerator: "CmdOrCtrl+Shift+I" },
      ],
    },
    {
      label: "頁面(&P)",
      submenu: [
        item("向右旋轉", "rotate-right", "CmdOrCtrl+R"),
        item("向左旋轉", "rotate-left", "CmdOrCtrl+Shift+R"),
        { type: "separator" },
        item("插入空白頁", "insert-blank", "CmdOrCtrl+Shift+N"),
        item("從檔案插入頁面…", "insert-file"),
        item("複製頁面", "duplicate-pages"),
        item("刪除頁面", "delete-pages", "CmdOrCtrl+Delete"),
        { type: "separator" },
        item("擷取頁面為新 PDF…", "extract-pages"),
        item("分割 PDF…", "split"),
        item("合併多個 PDF…", "merge"),
      ],
    },
    {
      label: "工具(&T)",
      submenu: [
        ...TOOLS.map(([id, label, key]) => item(key ? `${label}\t${key}` : label, `tool:${id}`)),
        { type: "separator" },
        item("簽名…", "signatures"),
        item("浮水印…", "watermark"),
        item("頁碼與頁首頁尾…", "page-numbers"),
        item("移除浮水印與頁碼", "remove-stamps"),
        item("新增書籤", "add-bookmark", "CmdOrCtrl+D"),
        { type: "separator" },
        item("套用遮蓋（永久移除內容）", "apply-redactions"),
        item("文字辨識（OCR）…", "ocr"),
        item("平面化所有註解與表單", "flatten"),
      ],
    },
    {
      label: "說明(&H)",
      submenu: [item("鍵盤快捷鍵", "shortcuts"), item("關於 PDF 編輯器", "about")],
    },
  ];
  return Menu.buildFromTemplate(template);
}

module.exports = { buildMenu };
