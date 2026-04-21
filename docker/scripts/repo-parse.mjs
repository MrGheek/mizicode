/**
 * repo-parse.mjs — Symbol extraction using Tree-sitter with regex fallback
 *
 * Tries to load tree-sitter + language grammars from npm.
 * Falls back to regex-based extraction if tree-sitter is unavailable.
 *
 * Returns: Array<{name, kind, line, lang, signature, docstring}>
 */

let _ts = null;
let _tsAvail = null;

async function loadTreeSitter() {
  if (_tsAvail !== null) return _tsAvail;
  try {
    const { default: Parser } = await import('tree-sitter');
    _ts = Parser;
    _tsAvail = true;
    return true;
  } catch {
    _tsAvail = false;
    return false;
  }
}

const LANG_CACHE = {};

async function getLanguage(lang) {
  if (LANG_CACHE[lang]) return LANG_CACHE[lang];
  const pkgMap = {
    ts: 'tree-sitter-typescript',
    tsx: 'tree-sitter-typescript',
    js: 'tree-sitter-javascript',
    jsx: 'tree-sitter-javascript',
    mjs: 'tree-sitter-javascript',
    cjs: 'tree-sitter-javascript',
    py: 'tree-sitter-python',
    go: 'tree-sitter-go',
    rs: 'tree-sitter-rust',
  };
  const pkg = pkgMap[lang];
  if (!pkg) return null;
  try {
    const mod = await import(pkg);
    const grammar = lang === 'ts' || lang === 'tsx'
      ? (mod.default?.typescript || mod.typescript || mod.default)
      : (mod.default || mod);
    LANG_CACHE[lang] = grammar;
    return grammar;
  } catch {
    return null;
  }
}

// ─── Tree-sitter extraction ───────────────────────────────────────────────────

const TS_SYMBOL_KINDS = {
  function_declaration: 'function',
  arrow_function: 'function',
  method_definition: 'method',
  function: 'function',
  class_declaration: 'class',
  class: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  variable_declarator: 'variable',
  lexical_declaration: 'variable',
  export_statement: null,
  function_item: 'function',
  impl_item: 'impl',
  struct_item: 'struct',
  trait_item: 'trait',
  enum_item: 'enum',
  function_definition: 'function',
  class_definition: 'class',
};

function getName(node) {
  const nameNode = node.childForFieldName?.('name') || node.children?.find(c => c.type === 'identifier');
  return nameNode?.text || null;
}

function extractTreeSitterSymbols(tree, lang) {
  const symbols = [];
  const seen = new Set();

  function walk(node, depth) {
    if (depth > 10) return;
    const kind = TS_SYMBOL_KINDS[node.type];
    if (kind) {
      const name = getName(node);
      if (name && !seen.has(`${name}:${node.startPosition.row}`)) {
        seen.add(`${name}:${node.startPosition.row}`);
        symbols.push({
          name,
          kind,
          line: node.startPosition.row + 1,
          lang,
          signature: node.text?.slice(0, 120).replace(/\s+/g, ' ') || null,
          docstring: null,
        });
      }
    }
    for (const child of node.children) {
      walk(child, depth + 1);
    }
  }

  walk(tree.rootNode, 0);
  return symbols;
}

// ─── Regex fallback extraction ────────────────────────────────────────────────

const REGEX_EXTRACTORS = {
  js: [
    { re: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm, kind: 'function' },
    { re: /^(?:export\s+)?class\s+(\w+)/gm, kind: 'class' },
    { re: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/gm, kind: 'function' },
    { re: /^(?:export\s+)?interface\s+(\w+)/gm, kind: 'interface' },
    { re: /^(?:export\s+)?type\s+(\w+)\s*=/gm, kind: 'type' },
  ],
  ts: [
    { re: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm, kind: 'function' },
    { re: /^(?:export\s+)?class\s+(\w+)/gm, kind: 'class' },
    { re: /^(?:export\s+)?interface\s+(\w+)/gm, kind: 'interface' },
    { re: /^(?:export\s+)?type\s+(\w+)\s*=/gm, kind: 'type' },
    { re: /^(?:export\s+)?enum\s+(\w+)/gm, kind: 'enum' },
    { re: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/gm, kind: 'function' },
  ],
  py: [
    { re: /^(?:async\s+)?def\s+(\w+)/gm, kind: 'function' },
    { re: /^class\s+(\w+)/gm, kind: 'class' },
  ],
  go: [
    { re: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/gm, kind: 'function' },
    { re: /^type\s+(\w+)\s+struct/gm, kind: 'struct' },
    { re: /^type\s+(\w+)\s+interface/gm, kind: 'interface' },
  ],
  rs: [
    { re: /^(?:pub\s+)?fn\s+(\w+)/gm, kind: 'function' },
    { re: /^(?:pub\s+)?struct\s+(\w+)/gm, kind: 'struct' },
    { re: /^(?:pub\s+)?trait\s+(\w+)/gm, kind: 'trait' },
    { re: /^(?:pub\s+)?enum\s+(\w+)/gm, kind: 'enum' },
    { re: /^(?:pub\s+)?impl\s+(?:<[^>]+>\s+)?(\w+)/gm, kind: 'impl' },
  ],
};

function extractRegexSymbols(code, lang) {
  const normLang = lang === 'tsx' ? 'ts' : lang === 'jsx' || lang === 'mjs' || lang === 'cjs' ? 'js' : lang;
  const extractors = REGEX_EXTRACTORS[normLang] || [];
  const symbols = [];
  const seen = new Set();

  for (const { re, kind } of extractors) {
    re.lastIndex = 0;
    const lines = code.split('\n');
    let m;
    while ((m = re.exec(code)) !== null) {
      const name = m[1];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const lineNum = code.slice(0, m.index).split('\n').length;
      symbols.push({
        name,
        kind,
        line: lineNum,
        lang,
        signature: m[0].slice(0, 120).replace(/\s+/g, ' '),
        docstring: null,
      });
    }
  }
  return symbols;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function extractSymbols(code, lang) {
  if (!code || code.length > 2 * 1024 * 1024) return extractRegexSymbols(code || '', lang);

  const tsOk = await loadTreeSitter();
  if (!tsOk) return extractRegexSymbols(code, lang);

  const grammar = await getLanguage(lang);
  if (!grammar) return extractRegexSymbols(code, lang);

  try {
    const parser = new _ts();
    parser.setLanguage(grammar);
    const tree = parser.parse(code);
    return extractTreeSitterSymbols(tree, lang);
  } catch (err) {
    return extractRegexSymbols(code, lang);
  }
}

export { extractRegexSymbols };
