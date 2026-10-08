import { useSyncExternalStore } from "react";
import type { DocInfo, Quad, SaveOptions, SearchHit } from "../engine/types";

export type Tool =
  | "select" | "edittext" | "highlight" | "underline" | "strikeout"
  | "note" | "textbox" | "ink"
  | "rectangle" | "ellipse" | "line" | "arrow"
  | "whiteout" | "redact" | "image" | "signature" | "eraser";

export type SidebarTab = "thumbnails" | "outline" | "annotations" | "search";
export type Layout = "continuous" | "twoUp";
export type FitMode = "width" | "page" | null;

export interface TextSelectionState {
  page: number;
  quads: Quad[];
  text: string;
}

export interface DocTab {
  key: string;
  engineId: number;
  name: string;
  path: string | null;
  dirty: boolean;
  info: DocInfo;
  /** 內容改變時遞增，觸發重新渲染 */
  revision: number;
  currentPage: number;
  selectedPages: number[];
  zoom: number;
  fit: FitMode;
  layout: Layout;
  /** 存檔時套用的密碼；null 代表不加密 */
  security: SaveOptions | null;
  searchQuery: string;
  searchHits: SearchHit[];
  searchIndex: number;
  selectedAnnot: { page: number; id: number } | null;
  textSelection: TextSelectionState | null;
  /** 要求檢視器捲動到的頁面（每次要求遞增 nonce） */
  scrollRequest: { page: number; y?: number; nonce: number } | null;
}

export interface PendingImage {
  data: Uint8Array;
  width: number;
  height: number;
  isSignature: boolean;
  url: string;
}

export interface AppState {
  tabs: DocTab[];
  activeKey: string | null;
  tool: Tool;
  color: string;
  lineWidth: number;
  fontSize: number;
  fillShapes: boolean;
  pendingImage: PendingImage | null;
  sidebar: boolean;
  sidebarTab: SidebarTab;
  progress: { title: string; done: number; total: number } | null;
  toast: { text: string; id: number } | null;
  recent: string[];
  engineError: string | null;
}

export const TOOL_DEFAULT_COLORS: Partial<Record<Tool, string>> = {
  highlight: "#ffd400",
  underline: "#1f9d55",
  strikeout: "#e03131",
  note: "#ffd400",
  ink: "#e03131",
  rectangle: "#e03131",
  ellipse: "#e03131",
  line: "#e03131",
  arrow: "#e03131",
  textbox: "#000000",
};

type Listener = () => void;

let state: AppState = {
  tabs: [],
  activeKey: null,
  tool: "select",
  color: "#000000",
  lineWidth: 2,
  fontSize: 14,
  fillShapes: false,
  pendingImage: null,
  sidebar: true,
  sidebarTab: "thumbnails",
  progress: null,
  toast: null,
  recent: [],
  engineError: null,
};

const listeners = new Set<Listener>();

export function getState(): AppState {
  return state;
}

export function setState(update: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const patch = typeof update === "function" ? update(state) : update;
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export function activeTab(s: AppState = state): DocTab | null {
  return s.tabs.find((t) => t.key === s.activeKey) ?? null;
}

export function useActiveTab(): DocTab | null {
  return useStore((s) => activeTab(s));
}

export function getTab(key: string): DocTab | null {
  return state.tabs.find((t) => t.key === key) ?? null;
}

export function updateTab(key: string, patch: Partial<DocTab> | ((t: DocTab) => Partial<DocTab>)) {
  setState((s) => ({
    tabs: s.tabs.map((t) => (t.key === key ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t)),
  }));
}

let toastId = 0;
export function toast(text: string) {
  const id = ++toastId;
  setState({ toast: { text, id } });
  setTimeout(() => {
    if (state.toast?.id === id) setState({ toast: null });
  }, 3200);
}

export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const n = parseInt(value.length === 3 ? value.split("").map((c) => c + c).join("") : value, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(color: number[]): string {
  if (color.length < 3) return "#888888";
  return "#" + color.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}
