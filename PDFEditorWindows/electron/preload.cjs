// 透過 contextBridge 提供畫面安全的系統功能。
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const on = (channel) => (callback) => {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("api", {
  openFiles: (kind, multiple, title) => ipcRenderer.invoke("dialog:open", { kind, multiple, title }),
  readFile: (path) => ipcRenderer.invoke("file:read", path),
  saveDialog: (title, defaultName, kind) => ipcRenderer.invoke("dialog:save", { title, defaultName, kind }),
  chooseFolder: (title) => ipcRenderer.invoke("dialog:folder", title),
  writeFile: (path, data) => ipcRenderer.invoke("file:write", path, data),
  writeFiles: (folder, files) => ipcRenderer.invoke("file:write-many", folder, files),
  showInFolder: (path) => ipcRenderer.invoke("shell:show", path),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  message: (options) => ipcRenderer.invoke("message", options),
  recent: {
    get: () => ipcRenderer.invoke("recent:get"),
    add: (path) => ipcRenderer.invoke("recent:add", path),
    clear: () => ipcRenderer.invoke("recent:clear"),
  },
  signatures: {
    list: () => ipcRenderer.invoke("signatures:list"),
    add: (data) => ipcRenderer.invoke("signatures:add", data),
    remove: (id) => ipcRenderer.invoke("signatures:remove", id),
  },
  setTitle: (title) => ipcRenderer.invoke("window:set-title", title),
  initialFiles: () => ipcRenderer.invoke("window:initial-files"),
  confirmClose: () => ipcRenderer.invoke("window:confirm-close"),
  print: (pages) => ipcRenderer.invoke("print", pages),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onMenu: on("menu"),
  onOpenFiles: on("open-files"),
  onCloseRequest: on("close-request"),
});
