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

/** Lenis drives the scroll; GSAP's ticker drives Lenis so ScrollTrigger and scroll stay in step. */
export function SmoothScroll() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const l = new Lenis({ lerp: 0.1, wheelMultiplier: 1 });
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
