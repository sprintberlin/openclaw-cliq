// Validate the es-module-lexer 2.x or 3.x import record before using it.
// An unknown shape must not turn the SDK scan into a false green.
export function readStaticSdkImport(entry) {
  if (entry && typeof entry.type === "string") {
    if (entry.type === "dynamic" || entry.type === "import-meta") return null;
    if (entry.type !== "static" && entry.type !== "reexport-star") {
      throw new Error(`unknown es-module-lexer import type: ${entry.type}`);
    }
    if (typeof entry.specifier !== "string" ||
        !Number.isInteger(entry.importStart) || !Number.isInteger(entry.importEnd)) {
      throw new Error("unknown es-module-lexer 3.x static import record shape");
    }
    return { module: entry.specifier, start: entry.importStart, end: entry.importEnd };
  }
  if (entry && Number.isInteger(entry.d)) {
    if (entry.d >= 0) return null;
    if (entry.d !== -1 || typeof entry.n !== "string" ||
        !Number.isInteger(entry.ss) || !Number.isInteger(entry.se)) {
      throw new Error("unknown es-module-lexer 2.x static import record shape");
    }
    return { module: entry.n, start: entry.ss, end: entry.se };
  }
  throw new Error("unknown es-module-lexer import record shape");
}
