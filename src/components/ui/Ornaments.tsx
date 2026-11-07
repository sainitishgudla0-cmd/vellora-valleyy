import Image from "next/image";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/format";

type Tone = "cream" | "light" | "sage" | "butter" | "forest" | "bark" | "gold" | "dough";
const BG: Record<Tone, string> = {
  cream: "bg-cream",
  light: "bg-cream-light",
  sage: "bg-sage",
  butter: "bg-butter",
  forest: "bg-forest",
  bark: "bg-bark",
  gold: "bg-gold",
  dough: "bg-dough",
};
const v = (o: Record<string, string | number>) => o as CSSProperties;

/**
 * Ornamental double-line frame with concave corners.
 */
export function Frame({
  children,
  className,
  innerClassName,
  tone = "light",
  line = "forest",
  n = 22,
  gap = 6,
}: {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
  tone?: Tone;
  line?: Tone;
  n?: number;
  gap?: number;
}) {
  const outer = 2;
  const hair = 1.5;
  return (
    <div className={cn("notch", BG[line], className)} style={v({ "--n": `${n}px`, "--i": "0px", padding: outer })}>
      <div className={cn("notch h-full", BG[tone])} style={v({ "--n": `${n}px`, "--i": `${outer}px`, padding: gap })}>
        <div className={cn("notch h-full", BG[line])} style={v({ "--n": `${n}px`, "--i": `${outer + gap}px`, padding: hair })}>
          <div className={cn("notch h-full", BG[tone], innerClassName)} style={v({ "--n": `${n}px`, "--i": `${outer + gap + hair}px` })}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Pointed hexagon badge with a double outline. */
export function HexBadge({
  children,
  className,
  innerClassName,
  tone = "light",
  line = "forest",
  h = 56,
}: {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
  tone?: Tone;
  line?: Tone;
  h?: number;
}) {
  return (
    <div className={cn("hex", BG[line], className)} style={v({ "--h": `${h}px`, padding: 2.5 })}>
      <div className={cn("hex h-full", BG[tone])} style={v({ "--h": `${h - 1.5}px`, padding: 7 })}>
        <div className={cn("hex h-full", BG[line])} style={v({ "--h": `${h - 5.5}px`, padding: 1.5 })}>
          <div className={cn("hex flex h-full flex-col items-center justify-center", BG[tone], innerClassName)} style={v({ "--h": `${h - 6.5}px` })}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Octagon stat badge. */
export function OctBadge({
  value,
  label,
  className,
  tone = "forest",
  line = "cream",
}: {
  value: ReactNode;
  label: ReactNode;
  className?: string;
  tone?: Tone;
  line?: Tone;
}) {
  const fg = tone === "forest" || tone === "bark" ? "text-cream" : "text-forest";
  return (
    <div className={cn("oct aspect-square", BG[tone], className)} style={{ padding: 7 }}>
      <div className={cn("oct h-full", BG[line])} style={{ padding: 1.5 }}>
        <div className={cn("oct flex h-full flex-col items-center justify-center text-center", BG[tone], fg)}>
          <span className="display text-[clamp(2.4rem,5vw,4.2rem)] leading-[0.85]">{value}</span>
          <span className="serif-italic mt-1 text-[clamp(.95rem,1.4vw,1.25rem)]">{label}</span>
        </div>
      </div>
    </div>
  );
}

/** Perforated-edge photo print. Tilt is applied on an inner element so scroll reveals can own the outer transform. */
export function Polaroid({
  src,
  alt,
  caption,
  tilt = 0,
  className,
  ratio = "4/5",
  sizes = "(min-width: 1024px) 320px, 60vw",
  priority,
  imgClassName,
}: {
  src: string;
  alt: string;
  caption?: string;
  tilt?: number;
  className?: string;
  ratio?: string;
  sizes?: string;
  priority?: boolean;
  imgClassName?: string;
}) {
  return (
    <div className={cn("drop", className)}>
      <div
        className="stamp transition-[rotate,scale] duration-700 ease-out-expo [rotate:var(--tilt)] hover:[rotate:0deg] hover:[scale:1.03]"
        style={v({ "--tilt": `${tilt}deg` })}
      >
        <div className="relative overflow-hidden bg-dough" style={{ aspectRatio: ratio }}>
          <Image src={src} alt={alt} fill sizes={sizes} priority={priority} className={cn("object-cover", imgClassName)} />
        </div>
        {caption && <p className="script mt-2 text-center text-[22px] text-forest">{caption}</p>}
      </div>
    </div>
  );
}

/** Infinite horizontal marquee. Children are duplicated for a seamless loop. */
export function Marquee({
  children,
  className,
  speed = 40,
  reverse,
}: {
  children: ReactNode;
  className?: string;
  speed?: number;
  reverse?: boolean;
}) {
  return (
    <div className={cn("marquee-pause flex overflow-hidden", className)}>
      <div
        className="flex w-max shrink-0 animate-marquee"
        style={v({ "--marquee-speed": `${speed}s`, animationDirection: reverse ? "reverse" : "normal" })}
      >
        <div className="flex shrink-0 items-center">{children}</div>
        <div className="flex shrink-0 items-center" aria-hidden>
          {children}
        </div>
      </div>
    </div>
  );
}

export function Stars({ n = 5, className }: { n?: number; className?: string }) {
  return (
    <span className={cn("inline-flex gap-0.5", className)} aria-label={`${n} out of 5`}>
      {Array.from({ length: 5 }, (_, i) => (
        <svg key={i} viewBox="0 0 20 20" className={cn("h-3.5 w-3.5", i < n ? "fill-current" : "fill-current opacity-25")}>
          <path d="M10 1.5l2.6 5.6 6 .7-4.5 4.1 1.2 6L10 15l-5.3 2.9 1.2-6L1.4 7.8l6-.7z" />
        </svg>
      ))}
    </span>
  );
}

/** Rotating circular text (CSS animation). */
export function CircleText({ text, className, size = 520, id = "circle" }: { text: string; className?: string; size?: number; id?: string }) {
  const r = size / 2 - 40;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className={cn("animate-spin-slower", className)} aria-hidden>
      <defs>
        <path id={id} d={`M ${size / 2},${size / 2} m -${r},0 a ${r},${r} 0 1,1 ${r * 2},0 a ${r},${r} 0 1,1 -${r * 2},0`} />
      </defs>
      <text className="display fill-current" style={{ fontSize: size * 0.085, letterSpacing: "0.02em" }}>
        <textPath href={`#${id}`} textLength={Math.floor(2 * Math.PI * r - 4)} lengthAdjust="spacing">
          {text}
        </textPath>
      </text>
    </svg>
  );
}
