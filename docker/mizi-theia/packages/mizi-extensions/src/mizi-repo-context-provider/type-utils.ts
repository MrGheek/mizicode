import { SymbolKind, Range, Position } from "@theia/core/shared/vscode-languageserver-protocol";
import { AISymbol } from "./types";

export const SYMBOL_KIND_MAP: Record<string, SymbolKind> = {
  function: SymbolKind.Function,
  method: SymbolKind.Method,
  class: SymbolKind.Class,
  interface: SymbolKind.Interface,
  constant: SymbolKind.Constant,
  variable: SymbolKind.Variable,
  struct: SymbolKind.Struct,
  enum: SymbolKind.Enum,
  module: SymbolKind.Module,
  namespace: SymbolKind.Namespace,
  property: SymbolKind.Property,
  field: SymbolKind.Field,
  constructor: SymbolKind.Constructor,
  file: SymbolKind.File,
  string: SymbolKind.String,
  number: SymbolKind.Number,
  boolean: SymbolKind.Boolean,
  array: SymbolKind.Array,
  object: SymbolKind.Object,
  key: SymbolKind.Key,
  null: SymbolKind.Null,
};

export function symbolKindFromString(kind: string): SymbolKind {
  return SYMBOL_KIND_MAP[kind.toLowerCase()] ?? SymbolKind.Function;
}

export function aisymbolToCallItem(sym: AISymbol, sessionId: string) {
  const range = Range.create(Position.create(Math.max(0, sym.line - 1), 0), Position.create(sym.line, 0));
  return {
    _sessionId: sessionId,
    _itemId: `${sym.filePath}:${sym.name}`,
    kind: symbolKindFromString(sym.kind),
    name: sym.name,
    detail: sym.filePath,
    uri: { scheme: "file", authority: "", path: `/${sym.filePath}`, query: "", fragment: "" },
    range,
    selectionRange: range,
  };
}

export function aisymbolToTypeItem(sym: AISymbol) {
  const range = Range.create(Position.create(Math.max(0, sym.line - 1), 0), Position.create(sym.line, 0));
  return {
    kind: symbolKindFromString(sym.kind),
    name: sym.name,
    detail: sym.filePath,
    uri: sym.filePath.startsWith("/") ? `file://${sym.filePath}` : `file:///${sym.filePath}`,
    range,
    selectionRange: range,
  };
}

export function uriToRepoPath(uri: string): string {
  const u = uri.startsWith("file://") ? uri.slice(7) : uri;
  return u.replace(/^\//, "");
}
