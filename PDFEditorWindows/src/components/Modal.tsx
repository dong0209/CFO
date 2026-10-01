import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";

interface ModalEntry {
  id: number;
  render: () => ReactNode;
}

let modals: ModalEntry[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

function emit() {
  listeners.forEach((l) => l());
}

/** 顯示自訂對話框；`render` 取得 `done` 函式，呼叫後關閉並回傳結果。 */
export function showModal<T>(render: (done: (value: T) => void) => ReactNode): Promise<T> {
  return new Promise((resolve) => {
    const id = nextId++;
    const done = (value: T) => {
      modals = modals.filter((m) => m.id !== id);
      emit();
      resolve(value);
    };
    modals = [...modals, { id, render: () => render(done) }];
    emit();
  });
}

export function hasOpenModal(): boolean {
  return modals.length > 0;
}

export function ModalHost() {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => modals,
  );
  return (
    <>
      {list.map((m) => (
        <div className="modal-backdrop" key={m.id}>
          {m.render()}
        </div>
      ))}
    </>
  );
}

interface DialogProps {
  title: string;
  children: ReactNode;
  onCancel: () => void;
  onConfirm?: () => void;
  confirmText?: string;
  confirmDisabled?: boolean;
  danger?: boolean;
  width?: number;
  extraButtons?: ReactNode;
}

/** 標準對話框外框：標題、內容、取消／確定按鈕，支援 Esc 與 Enter。 */
export function Dialog({ title, children, onCancel, onConfirm, confirmText = "確定", confirmDisabled, danger, width = 460, extraButtons }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>("input, textarea, select, button.primary");
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
  }, []);
  return (
    <div
      className="dialog"
      style={{ width }}
      ref={ref}
      role="dialog"
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        } else if (e.key === "Enter" && onConfirm && !confirmDisabled && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          onConfirm();
        }
      }}
    >
      <h2>{title}</h2>
      <div className="dialog-body">{children}</div>
      <div className="dialog-buttons">
        {extraButtons}
        <span className="spacer" />
        <button onClick={onCancel}>取消</button>
        {onConfirm && (
          <button className={danger ? "primary danger" : "primary"} onClick={onConfirm} disabled={confirmDisabled}>
            {confirmText}
          </button>
        )}
      </div>
    </div>
  );
}

interface PromptOptions {
  title: string;
  message?: string;
  initial?: string;
  multiline?: boolean;
  password?: boolean;
  confirmText?: string;
}

export function prompt(options: PromptOptions): Promise<string | null> {
  return showModal<string | null>((done) => <PromptDialog {...options} done={done} />);
}

function PromptDialog({ title, message, initial = "", multiline, password, confirmText, done }: PromptOptions & { done: (v: string | null) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <Dialog title={title} onCancel={() => done(null)} onConfirm={() => done(value)} confirmText={confirmText}>
      {message && <p className="muted">{message}</p>}
      {multiline ? (
        <textarea
          rows={5}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) done(value);
          }}
        />
      ) : (
        <input type={password ? "password" : "text"} value={value} onChange={(e) => setValue(e.target.value)} />
      )}
      {multiline && <p className="hint">按 Ctrl+Enter 確定</p>}
    </Dialog>
  );
}

export function confirmDialog(title: string, message: string, confirmText = "確定", danger = false): Promise<boolean> {
  return showModal<boolean>((done) => (
    <Dialog title={title} onCancel={() => done(false)} onConfirm={() => done(true)} confirmText={confirmText} danger={danger}>
      <p>{message}</p>
    </Dialog>
  ));
}

export function alertDialog(title: string, message: string): Promise<void> {
  return showModal<void>((done) => (
    <Dialog title={title} onCancel={() => done()} onConfirm={() => done()}>
      <p style={{ whiteSpace: "pre-wrap" }}>{message}</p>
    </Dialog>
  ));
}
