import { IconBox, IconFactory, IconShield, IconSprout, IconTruck } from "@/components/ui/Icons";

/** Five-stage quality process — wording from the brochure ("From Source to Shelf"). */
export const STAGES = [
  { key: "sourcing", title: "Sourcing", text: "Carefully selected farms and trusted suppliers for premium quality raw materials.", Icon: IconSprout },
  { key: "processing", title: "Processing", text: "Clean, modern facilities with standardised processing to retain taste and goodness.", Icon: IconFactory },
  { key: "quality", title: "Quality check", text: "Multi-level quality checks to ensure consistency, safety and freshness.", Icon: IconShield },
  { key: "packaging", title: "Packaging", text: "Hygienic, sealed and attractive packaging to lock in freshness and ensure safety.", Icon: IconBox },
  { key: "distribution", title: "Distribution", text: "Bulk supply capability and timely delivery across India with care and commitment.", Icon: IconTruck },
] as const;
