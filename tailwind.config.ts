import type { Config } from "tailwindcss";

/**
 * Velora Valley design tokens.
 * Forest + golden-yellow + cream palette taken from the brochure and logo.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        forest: {
          DEFAULT: "#13402d",
          deep: "#0b2a1d",
          ink: "#0f3424",
          logo: "#1b5a36",
        },
        leaf: { DEFAULT: "#2f7a40", light: "#9cbf3b" },
        gold: { DEFAULT: "#e6ac16", light: "#f4cb4d", deep: "#c18d06" },
        cream: { DEFAULT: "#f5efe4", light: "#fbf8f1" },
        dough: "#ebe1d0",
        sage: { DEFAULT: "#e1e9c8", deep: "#cfdcaa" },
        butter: "#f7e7b2",
        bark: { DEFAULT: "#4a3526", deep: "#2c2016" },
      },
      fontFamily: {
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        serif: ["var(--font-serif)", "Georgia", "serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
        script: ["var(--font-script)", "cursive"],
      },
      fontSize: {
        "display-2xl": ["clamp(3.5rem, 11vw, 10rem)", { lineHeight: "0.86", letterSpacing: "-0.01em" }],
        "display-xl": ["clamp(3rem, 8.5vw, 8rem)", { lineHeight: "0.88", letterSpacing: "-0.01em" }],
        "display-lg": ["clamp(2.6rem, 6.5vw, 6.5rem)", { lineHeight: "0.9" }],
        "display-md": ["clamp(2.2rem, 5vw, 5.5rem)", { lineHeight: "0.92" }],
        "display-sm": ["clamp(1.9rem, 3.6vw, 4rem)", { lineHeight: "0.95" }],
        "display-xs": ["clamp(1.6rem, 2.6vw, 3rem)", { lineHeight: "0.98" }],
      },
      maxWidth: { site: "1440px" },
      boxShadow: {
        card: "0 1px 0 rgba(15,52,36,.08), 0 18px 40px -22px rgba(15,52,36,.45)",
        lift: "0 2px 0 rgba(15,52,36,.06), 0 30px 60px -28px rgba(15,52,36,.55)",
        polaroid: "0 22px 40px -18px rgba(20,25,10,.55)",
      },
      transitionTimingFunction: {
        "out-expo": "cubic-bezier(0.16, 1, 0.3, 1)",
        "in-out-quart": "cubic-bezier(0.76, 0, 0.24, 1)",
      },
      keyframes: {
        marquee: { from: { transform: "translateX(0)" }, to: { transform: "translateX(-50%)" } },
        spin: { to: { transform: "rotate(360deg)" } },
        bob: { "0%,100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(6px)" } },
      },
      animation: {
        marquee: "marquee var(--marquee-speed, 40s) linear infinite",
        "spin-slow": "spin 40s linear infinite",
        "spin-slower": "spin 70s linear infinite",
        bob: "bob 2.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
export default config;
