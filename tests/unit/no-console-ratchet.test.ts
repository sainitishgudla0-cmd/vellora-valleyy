/** M9-T5: all server logging goes through src/lib/log.ts (structured, redacted). New `console.*` calls fail this test. */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []));

describe("no direct console usage in src/", () => {
  it("only src/lib/log.ts may call console.*", () => {
    const offenders = walk("src")
      .filter((f) => f.split(path.sep).join("/") !== "src/lib/log.ts")
      .filter((f) => /\bconsole\.(log|info|warn|error|debug|trace)\b/.test(fs.readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")));
    expect(offenders, `use log.* from @/lib/log instead: ${offenders.join(", ")}`).toEqual([]);
  });
});
