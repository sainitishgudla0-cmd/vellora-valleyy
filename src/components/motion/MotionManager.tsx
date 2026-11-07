"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { gsap, ScrollTrigger, SplitText, prefersReducedMotion } from "@/lib/gsap";

/**
 * Declarative scroll animations for server-rendered markup.
 *
 *   data-reveal="up|fade|scale|left|right|drop"   reveal on enter (batched + staggered)
 *   data-delay="0.2"                               optional extra delay (s)
 *   data-split="words|chars"                       masked line/word/char rise for headings
 *   data-parallax="0.15"                           scrubbed vertical drift (fraction of element height)
 *   data-rotate-scroll="20"                        scrubbed rotation in degrees while in view
 *
 * New nodes (client-rendered lists etc.) are picked up via a MutationObserver.
 */
const FROM: Record<string, gsap.TweenVars> = {
  up: { y: 48, opacity: 0 },
  fade: { opacity: 0 },
  scale: { scale: 0.88, opacity: 0 },
  left: { x: -60, opacity: 0 },
  right: { x: 60, opacity: 0 },
  drop: { y: -40, rotate: -8, scale: 0.9, opacity: 0 },
};

export function MotionManager() {
  const pathname = usePathname();

  useEffect(() => {
    const reduced = prefersReducedMotion();
    const ctx = gsap.context(() => {});
    const splits: SplitText[] = [];

    const setup = (root: ParentNode) => {
      ctx.add(() => {
        // ── reveals
        const reveals = Array.from(root.querySelectorAll<HTMLElement>("[data-reveal]:not([data-motion-ready])"));
        reveals.forEach((el) => el.setAttribute("data-motion-ready", ""));
        if (reveals.length) {
          if (reduced) {
            gsap.set(reveals, { opacity: 1, clearProps: "transform" });
          } else {
            reveals.forEach((el) => gsap.set(el, FROM[el.dataset.reveal || "up"] ?? FROM.up));
            ScrollTrigger.batch(reveals, {
              start: "top 88%",
              once: true,
              onEnter: (batch) =>
                gsap.to(batch, {
                  x: 0,
                  y: 0,
                  rotate: (_i, el: HTMLElement) => Number(el.dataset.finalRotate ?? 0),
                  scale: 1,
                  opacity: 1,
                  duration: 1.2,
                  stagger: 0.09,
                  delay: (_i, el: HTMLElement) => Number(el.dataset.delay ?? 0),
                  overwrite: true,
                }),
            });
          }
        }

        // ── split headings
        root.querySelectorAll<HTMLElement>("[data-split]:not([data-motion-ready])").forEach((el) => {
          el.setAttribute("data-motion-ready", "");
          if (reduced) {
            el.style.visibility = "visible";
            return;
          }
          const mode = el.dataset.split === "chars" ? "chars" : "words";
          const split = SplitText.create(el, {
            type: mode === "chars" ? "lines,words,chars" : "lines,words",
            mask: "lines",
            autoSplit: true,
            onSplit(self) {
              el.style.visibility = "visible";
              return gsap.from(mode === "chars" ? self.chars : self.words, {
                yPercent: 115,
                rotate: mode === "chars" ? 6 : 3,
                duration: 1.15,
                stagger: mode === "chars" ? 0.025 : 0.06,
                delay: Number(el.dataset.delay ?? 0),
                scrollTrigger: { trigger: el, start: "top 90%", once: true },
              });
            },
          });
          splits.push(split);
        });

        if (!reduced) {
          // ── parallax
          root.querySelectorAll<HTMLElement>("[data-parallax]:not([data-motion-ready])").forEach((el) => {
            el.setAttribute("data-motion-ready", "");
            const amt = Number(el.dataset.parallax) || 0.15;
            gsap.fromTo(
              el,
              { yPercent: -amt * 100 },
              {
                yPercent: amt * 100,
                ease: "none",
                scrollTrigger: { trigger: el.parentElement ?? el, start: "top bottom", end: "bottom top", scrub: true },
              },
            );
          });
          // ── scroll-drawn lines (scaleY 0 → 1 across the parent)
          root.querySelectorAll<HTMLElement>("[data-draw]:not([data-motion-ready])").forEach((el) => {
            el.setAttribute("data-motion-ready", "");
            gsap.fromTo(
              el,
              { scaleY: 0, transformOrigin: "top center" },
              { scaleY: 1, ease: "none", scrollTrigger: { trigger: el.parentElement ?? el, start: "top 70%", end: "bottom 70%", scrub: true } },
            );
          });
          // ── scroll-linked rotation
          root.querySelectorAll<HTMLElement>("[data-rotate-scroll]:not([data-motion-ready])").forEach((el) => {
            el.setAttribute("data-motion-ready", "");
            const deg = Number(el.dataset.rotateScroll) || 30;
            gsap.fromTo(
              el,
              { rotate: -deg / 2 },
              { rotate: deg / 2, ease: "none", scrollTrigger: { trigger: el, start: "top bottom", end: "bottom top", scrub: true } },
            );
          });
        }
      });
    };

    // wait a frame so the new route has painted
    const raf = requestAnimationFrame(() => {
      setup(document);
      ScrollTrigger.refresh();
    });

    let pending = false;
    const mo = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        setup(document);
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });

    // refresh once fonts & images settle
    const refresh = () => ScrollTrigger.refresh();
    document.fonts?.ready.then(refresh);
    window.addEventListener("load", refresh);

    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
      window.removeEventListener("load", refresh);
      splits.forEach((s) => s.revert());
      ctx.revert();
      document.querySelectorAll("[data-motion-ready]").forEach((el) => el.removeAttribute("data-motion-ready"));
    };
  }, [pathname]);

  return null;
}
