import { useEffect, useState } from "react";
import { choiceKey, downloadableFamilies, type FontChoice, parseChoice, systemFamilies } from "../lib/fonts";

export interface FontSettings {
  choice: FontChoice;
  bold: boolean;
  italic: boolean;
  size: number;
  /** #rrggbb */
  color: string;
}

/** 字型選單：自動（原字型）、電腦上的字型、可自動下載的開源字型，加上粗體、斜體、字級與顏色。 */
export function FontControls({ value, onChange, autoLabel, compact }: {
  value: FontSettings;
  onChange: (next: FontSettings) => void;
  /** 有值時顯示「自動」選項（編輯原有文字時） */
  autoLabel?: string;
  compact?: boolean;
}) {
  const [families, setFamilies] = useState<Array<{ family: string; label: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    systemFamilies().then((list) => !cancelled && setFamilies(list));
    return () => {
      cancelled = true;
    };
  }, []);
  const set = (patch: Partial<FontSettings>) => onChange({ ...value, ...patch });
  const key = choiceKey(value.choice);
  const known = key === "auto" || families.some((f) => `system:${f.family}` === key) || downloadableFamilies.some((f) => `download:${f}` === key);

  return (
    <div className={compact ? "font-controls compact" : "font-controls"} onPointerDown={(e) => e.stopPropagation()}>
      <select className="font-family" aria-label="字型" title="字型" value={key} onChange={(e) => set({ choice: parseChoice(e.target.value) })}>
        {autoLabel !== undefined && <option value="auto">自動：{autoLabel}</option>}
        {!known && value.choice.kind !== "auto" && <option value={key}>{value.choice.family}</option>}
        <optgroup label="可自動下載的開源字型">
          {downloadableFamilies.map((family) => (
            <option key={family} value={`download:${family}`}>
              {family}
            </option>
          ))}
        </optgroup>
        <optgroup label={families.length ? "電腦上的字型" : "電腦上的字型（讀取中…）"}>
          {families.map((f) => (
            <option key={f.family} value={`system:${f.family}`}>
              {f.label}
            </option>
          ))}
        </optgroup>
      </select>
      <button type="button" className={value.bold ? "font-toggle active" : "font-toggle"} title="粗體" aria-pressed={value.bold} onClick={() => set({ bold: !value.bold })}>
        <b>B</b>
      </button>
      <button type="button" className={value.italic ? "font-toggle active" : "font-toggle"} title="斜體" aria-pressed={value.italic} onClick={() => set({ italic: !value.italic })}>
        <i>I</i>
      </button>
      <input
        type="number"
        className="font-size"
        aria-label="字級"
        title="字級（pt）"
        min={4}
        max={200}
        step={0.5}
        value={value.size}
        onChange={(e) => set({ size: Math.min(200, Math.max(4, Number(e.target.value) || value.size)) })}
      />
      <input type="color" className="font-color" aria-label="文字顏色" title="文字顏色" value={value.color} onChange={(e) => set({ color: e.target.value })} />
    </div>
  );
}
