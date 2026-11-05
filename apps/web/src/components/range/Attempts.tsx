"use client";

import { useState } from "react";
import { type Entry, verdict, verdictColor } from "@/lib/range";
import { Transcript } from "./Transcript";

const badge = (e: Entry) => {
  if (e.breach) return { text: "Breach", color: "var(--color-string)" };
  const v = verdict(e);
  const text = { paid: "Allowed", waiting: "Held", refused: "Refused", none: "No payment" }[v.kind];
  return { text, color: verdictColor[v.kind] };
};

const ago = (t: number) => {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  return s < 60
    ? `${s}s ago`
    : s < 3600
      ? `${Math.round(s / 60)}m ago`
      : s < 86_400
        ? `${Math.round(s / 3600)}h ago`
        : `${Math.round(s / 86_400)}d ago`;
};

export function AttemptList({ entries }: { entries: Entry[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <ul className="border-t border-paper/15">
      {entries.map((e) => {
        const b = badge(e);
        const v = verdict(e);
        return (
          <li key={e.id} className="border-b border-paper/15">
            <button
              type="button"
              aria-expanded={open === e.id}
              onClick={() => setOpen(open === e.id ? null : e.id)}
              className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-2 py-6 text-left"
            >
              <span className="mono block break-all text-[0.78rem] text-dim-ink">
                #{e.id} · {e.account} · {ago(e.at)}
              </span>
              <span
                className="eyebrow row-span-2 whitespace-nowrap border px-2 py-1 text-[0.65rem]"
                style={{ color: b.color, borderColor: b.color }}
              >
                {b.text}
              </span>
              <span className="line-clamp-2 break-words leading-snug text-paper/85">
                {e.prompt}
              </span>
            </button>
            {open === e.id && (
              <div className="pb-8">
                <p className="eyebrow mb-6" style={{ color: verdictColor[v.kind] }}>
                  {v.label}
                </p>
                <Transcript prompt={e.prompt} steps={e.steps} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
