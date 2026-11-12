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
 * Scrolls to the element named in the URL's hash, if any, and holds it there while sections above
 * it load their data, until the reader scrolls or a few seconds pass.
 */
export function scrollToHash() {
  const id = decodeURIComponent(window.location.hash.slice(1));
  if (!id) return;
  // A jump, not a glide: the browser may already be at the section while Lenis still thinks the
  // page is at the top, and a glide would start from there.
  const go = () => {
    const el = document.getElementById(id);
    if (!el) return;
    if (Math.abs(el.getBoundingClientRect().top - 24) < 4) return;
    if (lenis) lenis.scrollTo(el, { offset: -24, immediate: true, force: true });
    else el.scrollIntoView({ block: "start" });
  };
  // ResizeObserver runs after layout and before paint, so the correction lands in the same frame
  // as the content that pushed the section down, and the section never visibly moves.
  const ro = new ResizeObserver(go);
  ro.observe(document.body);
  const stop = () => {
    ro.disconnect();
    for (const e of userScroll) window.removeEventListener(e, stop);
  };
  for (const e of userScroll) window.addEventListener(e, stop, { passive: true, once: true });
  requestAnimationFrame(go);
  setTimeout(stop, 4000);
}

const userScroll = ["wheel", "touchstart", "keydown", "mousedown"] as const;

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
