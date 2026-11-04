// The style guide's stamp (design/style-guide/stamp.json): a hash of each input the guide was rendered from, so the
// QA gate can tell when DESIGN.md or STYLE-GUIDE.md has changed since (docs/SPEC.md section 12, "Style guide").
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export const STAMP = "design/style-guide/stamp.json";
export const INPUTS = ["DESIGN.md", "STYLE-GUIDE.md"];

export const hash = (text) => createHash("sha256").update(String(text || "")).digest("hex").slice(0, 16);

export const readInputs = () => Object.fromEntries(INPUTS.map((f) => [f, existsSync(f) ? readFileSync(f, "utf8") : ""]));

// Which inputs changed since the guide was rendered.
export function staleInputs(stamp, inputs) {
  if (!stamp) return Object.keys(inputs);
  return Object.entries(inputs).filter(([name, text]) => stamp.inputs?.[name] !== hash(text)).map(([name]) => name);
}
