import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/format";

type Variant = "gold" | "forest" | "cream";
type Size = "sm" | "md" | "lg";

const vc: Record<Variant, string> = { gold: "", forest: "btn-forest", cream: "btn-cream" };
const sc: Record<Size, string> = { sm: "btn-sm", md: "", lg: "btn-lg" };

/** Label that rolls up on hover. */
export function Roll({ children }: { children: string }) {
  return (
    <span className="roll">
      <span data-text={children}>{children}</span>
    </span>
  );
}

export function ButtonLink({
  href,
  children,
  variant = "gold",
  size = "md",
  className,
  icon,
}: {
  href: string;
  children: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <Link href={href} className={cn("btn", vc[variant], sc[size], className)}>
      <Roll>{children}</Roll>
      {icon}
    </Link>
  );
}

export function Button({
  children,
  variant = "gold",
  size = "md",
  className,
  icon,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: string; variant?: Variant; size?: Size; icon?: ReactNode }) {
  return (
    <button className={cn("btn", vc[variant], sc[size], className)} {...rest}>
      <Roll>{children}</Roll>
      {icon}
    </button>
  );
}
