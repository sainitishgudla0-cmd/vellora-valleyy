import { describe, expect, it } from "vitest";
import { availableUnits, effectiveInStock } from "@/lib/inventory/availability";

const v = (over: Partial<{ inStock: boolean; trackInventory: boolean; stockQuantity: number; reserved: number }> = {}) => ({ inStock: true, trackInventory: false, stockQuantity: 0, reserved: 0, ...over });

describe("availability rules", () => {
  it("untracked variants follow the manual flag and have no unit count", () => {
    expect(effectiveInStock(v({ inStock: true }))).toBe(true);
    expect(effectiveInStock(v({ inStock: false }))).toBe(false);
    expect(availableUnits(v())).toBeNull();
  });
  it("tracked variants are judged by units on hand minus reserved, ignoring the flag", () => {
    expect(effectiveInStock(v({ trackInventory: true, stockQuantity: 5, reserved: 4, inStock: false }))).toBe(true);
    expect(effectiveInStock(v({ trackInventory: true, stockQuantity: 5, reserved: 5, inStock: true }))).toBe(false);
    expect(effectiveInStock(v({ trackInventory: true, stockQuantity: 0 }))).toBe(false);
    expect(availableUnits(v({ trackInventory: true, stockQuantity: 5, reserved: 2 }))).toBe(3);
  });
  it("never reports negative units", () => {
    expect(availableUnits(v({ trackInventory: true, stockQuantity: 1, reserved: 3 }))).toBe(0);
  });
});
