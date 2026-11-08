"use client";

import { useEffect, useRef } from "react";

/**
 * A list in its own scroll area. A conversation (`pin`) stays on the newest message unless the
 * reader has scrolled up to read something earlier.
 */
export function ChatLog({
  children,
  count,
  pin = true,
  className = "",
}: {
  children: React.ReactNode;
  pin?: boolean;
  /** Changes whenever the log grows, such as `${messages}-${busy}`. */
  count: number | string;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when a message is added
  useEffect(() => {
    const el = box.current;
    if (el && pin && pinned.current) el.scrollTop = el.scrollHeight;
  }, [count]);

  return (
    <div
      ref={box}
      data-lenis-prevent
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      className={`scroll-box ${className}`}
    >
      {children}
    </div>
  );
}

/** One message: the buyer's on the right, the agent's on the left. */
export function Bubble({ who, children }: { who: "you" | "agent"; children: React.ReactNode }) {
  const you = who === "you";
  return (
    <li className={`flex flex-col ${you ? "items-end" : "items-start"}`}>
      <span className="mb-1.5 label text-dim-ink">{you ? "You" : "Agent"}</span>
      <div
        className={`max-w-[88%] whitespace-pre-wrap wrap-break-word px-4 py-3 leading-relaxed ${you ? "bg-paper text-ink" : "border border-paper/12 bg-ink-3 text-paper/90"}`}
      >
        {children}
      </div>
    </li>
  );
}
