import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem = "separator" | { label: string; action: () => unknown; danger?: boolean; disabled?: boolean };

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPosition({ left: Math.min(x, window.innerWidth - width - 4), top: Math.min(y, window.innerHeight - height - 4) });
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div className="context-menu" ref={ref} style={position} role="menu">
      {items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="menu-separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={item.danger ? "danger" : ""}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.action();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
