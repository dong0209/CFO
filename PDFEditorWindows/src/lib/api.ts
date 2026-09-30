import type { FontRequest } from "../engine/fonts";

export interface LoadedFile {
  path: string;
  name: string;
  data: Uint8Array;
}

export interface ResolvedFont {
  data: Uint8Array;
  /** 字型集合（.ttc）中的第幾個字型 */
  index: number;
  name: string;
  source: "system" | "download";
  /** true：與原字型相同；false：相近的替代字型 */
  exact: boolean;
}

export interface MessageOptions {
  type?: "none" | "info" | "error" | "question" | "warning";
  message: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
}

export interface DesktopApi {
  openFiles(kind: "pdf" | "images", multiple: boolean, title?: string): Promise<LoadedFile[]>;
  readFile(path: string): Promise<LoadedFile>;
  saveDialog(title: string, defaultName: string, kind?: "pdf" | "text"): Promise<string | null>;
  chooseFolder(title: string): Promise<string | null>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  writeFiles(folder: string, files: Array<{ name: string; data: Uint8Array }>): Promise<string[]>;
  showInFolder(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  message(options: MessageOptions): Promise<number>;
  recent: { get(): Promise<string[]>; add(path: string): Promise<void>; clear(): Promise<void> };
  signatures: {
    list(): Promise<Array<{ id: string; data: Uint8Array }>>;
    add(data: Uint8Array): Promise<void>;
    remove(id: string): Promise<void>;
  };
  setTitle(title: string): Promise<void>;
  initialFiles(): Promise<string[]>;
  confirmClose(): Promise<void>;
  print(pages: Array<{ data: Uint8Array; width: number; height: number }>): Promise<void>;
  resolveFont(request: FontRequest): Promise<ResolvedFont | null>;
  /** 電腦上已安裝的字族 */
  listFonts(): Promise<Array<{ family: string; label: string }>>;
  pathForFile(file: File): string;
  onMenu(callback: (command: string) => void): () => void;
  onOpenFiles(callback: (paths: string[]) => void): () => void;
  onCloseRequest(callback: () => void): () => void;
}

declare global {
  interface Window {
    api: DesktopApi;
  }
}

export const api = (): DesktopApi => window.api;
