"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { useEffect } from "react";

gsap.registerPlugin(ScrollTrigger);

let lenis: Lenis | null = null;

/** Freezes page scroll (and Lenis) while an overlay is open. */
export function lockScroll(locked: boolean) {
  document.documentElement.style.overflow = locked ? "hidden" : "";
  if (locked) lenis?.stop();
  else lenis?.start();
}

/**
 * Scrolls to the element named in the URL's hash, if any. Pages whose sections load data call it
 * once they've laid out; it re-aims once more in case later content moved the target.
 */
export function scrollToHash() {
  const id = decodeURIComponent(window.location.hash.slice(1));
  if (!id) return;
  const go = () => {
    const el = document.getElementById(id);
    if (!el) return;
    if (lenis) lenis.scrollTo(el, { offset: -24 });
    else el.scrollIntoView({ block: "start" });
  };
  setTimeout(go, 350);
  setTimeout(go, 1500);
}

/** Lenis drives the scroll; GSAP's ticker drives Lenis so ScrollTrigger and scroll stay in step. */
export function SmoothScroll() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Nested scroll lets a chat box scroll natively while it can, and hands the wheel back to
    // the page at its top or bottom instead of swallowing it.
    const l = new Lenis({ lerp: 0.1, wheelMultiplier: 1, allowNestedScroll: true });
    lenis = l;
    l.on("scroll", ScrollTrigger.update);
    const tick = (time: number) => l.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    return () => {
      gsap.ticker.remove(tick);
      l.destroy();
      lenis = null;
    };
  }, []);
  return null;
}
