// Helpers for plain-text fields: paragraphs are separated by a blank line; lists have one item per line.
export const paragraphs = (text) => String(text || "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
export const lines = (text) => String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
