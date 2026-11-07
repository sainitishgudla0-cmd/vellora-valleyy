"use client";
import { IconMinus, IconPlus } from "@/components/ui/Icons";
import { MAX_QTY } from "@/store/cart";
import { cn } from "@/lib/format";

export function QuantityStepper({
  value,
  onChange,
  min = 1,
  size = "md",
  label = "Quantity",
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  size?: "sm" | "md";
  label?: string;
}) {
  const h = size === "sm" ? "h-9" : "h-12";
  const w = size === "sm" ? "w-9" : "w-12";
  return (
    <div className={cn("inline-flex items-center rounded-full border-[1.5px] border-forest/25 bg-cream-light", h)} role="group" aria-label={label}>
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        aria-label="Decrease quantity"
        className={cn("flex h-full items-center justify-center rounded-full transition-colors hover:bg-sage disabled:opacity-30", w)}
      >
        <IconMinus width={16} />
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={MAX_QTY}
        value={value}
        aria-label={label}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (!Number.isNaN(n)) onChange(Math.min(MAX_QTY, Math.max(min, n)));
        }}
        className="w-9 appearance-none bg-transparent text-center text-[15px] outline-none [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
      <button
        type="button"
        onClick={() => onChange(Math.min(MAX_QTY, value + 1))}
        disabled={value >= MAX_QTY}
        aria-label="Increase quantity"
        className={cn("flex h-full items-center justify-center rounded-full transition-colors hover:bg-sage disabled:opacity-30", w)}
      >
        <IconPlus width={16} />
      </button>
    </div>
  );
}
