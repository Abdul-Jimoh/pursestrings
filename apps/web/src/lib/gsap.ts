"use client";

import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { MorphSVGPlugin } from "gsap/MorphSVGPlugin";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";

gsap.registerPlugin(
  useGSAP,
  ScrollTrigger,
  SplitText,
  DrawSVGPlugin,
  MorphSVGPlugin,
  MotionPathPlugin,
);

export { DrawSVGPlugin, gsap, MorphSVGPlugin, MotionPathPlugin, ScrollTrigger, SplitText, useGSAP };

export const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Slides each line of `targets` up from behind its own mask. Re-splits on resize and font load,
 * keeping the animation's progress; un-hides `.reveal` targets once they're split.
 */
export function revealLines(targets: string | Element | Element[], vars: gsap.TweenVars = {}) {
  return SplitText.create(targets, {
    type: "lines",
    mask: "lines",
    linesClass: "line",
    autoSplit: true,
    onSplit: (self) => {
      gsap.set(self.elements, { autoAlpha: 1 });
      return gsap.from(self.lines, {
        yPercent: 105,
        duration: 1.15,
        stagger: 0.09,
        ease: "power4.out",
        ...vars,
      });
    },
  });
}
