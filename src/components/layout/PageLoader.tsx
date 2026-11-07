"use client";
import Image from "next/image";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";

/**
 * Short brand intro on the first visit of a session (~1s). Skipped for
 * reduced-motion users and on repeat navigations.
 */
export function PageLoader() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let seen = false;
    try {
      seen = sessionStorage.getItem("vv-intro") === "1";
      sessionStorage.setItem("vv-intro", "1");
    } catch {
      /* storage unavailable */
    }
    if (seen || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    (window as unknown as { __vvIntro?: boolean }).__vvIntro = true;
    setShow(true);
  }, []);

  useEffect(() => {
    if (!show) return;
    const t = window.setTimeout(() => setShow(false), 1100);
    return () => window.clearTimeout(t);
  }, [show]);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="loader"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-forest"
          exit={{ clipPath: "inset(0 0 100% 0)" }}
          transition={{ duration: 0.85, ease: [0.76, 0, 0.24, 1] }}
          aria-hidden
        >
          <motion.div initial={{ opacity: 0, y: 20, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}>
            <Image src="/images/brand/logo-cream.png" alt="" width={555} height={247} priority className="w-[200px]" />
          </motion.div>
          <motion.span
            className="absolute bottom-[18%] h-[2px] w-[160px] origin-left bg-gold"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 0.9, ease: [0.76, 0, 0.24, 1] }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
