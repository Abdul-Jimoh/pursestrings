"use client";

import { useEffect, useRef } from "react";

/** One line of text scaled so it spans its container exactly, at any width and after fonts load. */
export function FitText({ children, className = "" }: { children: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    // Width isn't linear in font size for this face, so converge in a few passes.
    const fit = () => {
      let size = 100;
      for (let i = 0; i < 4; i++) {
        el.style.fontSize = `${size}px`;
        const w = el.getBoundingClientRect().width;
        if (w === 0) return;
        size *= box.clientWidth / w;
      }
      el.style.fontSize = `${Math.floor(size * 10) / 10}px`;
    };
    fit();
    document.fonts.ready.then(fit);
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  return (
    <span ref={ref} className={`inline-block whitespace-nowrap ${className}`}>
      {children}
    </span>
  );
}
