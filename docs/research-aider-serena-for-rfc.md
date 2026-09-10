# Research Findings: Aider Repo-Map & Serena Symbolic Editing
## For MIZI Token-Cost-Optimization RFC

---

## 1. AIDER REPO-MAP

### 1.1 How It Builds the Code Graph

**File:** `aider/repomap.py`

Aider builds a **MultiDiGraph** (directed multigraph) using NetworkX. The graph nodes are files; edges are identifier references between files.

**Tag extraction pipeline:**

1. Each source file is parsed with **tree-sitter** using per-language `tags.scm` query files (stored in `aider/queries/tree-sitter-language-pack/` or `aider/queries/tree-sitter-languages/`).
2. The queries capture two kinds of named nodes: `name.definition.*` (defs) and `name.reference.*` (refs), producing `Tag(rel_fname, fname, line, name, kind="def"|"ref")`.
3. Tags are **cached per-file on disk** using `diskcache.Cache` (SQLite-backed) keyed by `(fname, mtime)`. Cache is invalidated when `os.path.getmtime()` changes. Directory: `.aider.tags.cache.v{VERSION}`.
4. **Fallback for languages without refs:** If a file has defs but no refs (e.g., C++), Aider falls back to Pygments lexing to extract `Token.Name` tokens as synthetic refs.

**Graph construction:**

```
for each identifier `ident` found in both defines and references:
    definers = defines[ident]          # set of files that define it
    references[ident] = list of (file, count)  # files that reference it

    edge_weight = base_mul * sqrt(num_refs) * mention_multiplier
    for each (referencer, definer):
        G.add_edge(referencer, definer, weight=edge_weight, ident=ident)
```

**Edge weight multipliers (critical for ranking):**

| Multiplier | Value | When Applied |
|---|---|---|
| `base_mul` | 1.0 | Default |
| `is_snake/is_kebab/is_camel AND len ≥ 8` | ×10 | Identifier is a long, meaningful name |
| `ident in mentioned_idents` | ×10 | User/LM mentioned the identifier in chat |
| `referencer in chat_rel_fnames` | ×50 | File is in the current chat (being edited) |
| `ident starts with _` | ×0.1 | Private/internal identifiers |
| `len(defines[ident]) > 5` | ×0.1 | Very common identifier (overloaded) |
| `sqrt(num_refs)` | — | Sub-linear scaling of ref count |

**Self-edges:** A small weight=0.1 self-edge is added for definitions that have no references (helps with languages like Ruby where tree-sitter 0.23.2 doesn't always capture both def and ref).

### 1.2 Ranking Algorithm: PageRank + Personalized Damping

**Exact algorithm:**

```python
# Personalization vector: chat files and mentioned files get higher probability
personalization[fname] = personalize  # = 100 / num_files
# Multiple boosts stack: chat file + mentioned fname + path-component match

ranked = nx.pagerank(G, weight="weight", personalization=personalization, dangling=personalization)
```

- Uses **NetworkX `pagerank`** with `weight="weight"` (edge weights from above).
- `personalization` dict biases the random walk toward chat files and mentioned identifiers — this is how "related to changed files" works.
- `dangling=personalization` handles dangling nodes (files with no out-edges) by distributing their rank according to the personalization vector.
- Falls back to un-personalized PageRank on `ZeroDivisionError`.

**Rank aggregation across definitions:**

After PageRank runs on *file nodes*, the rank is distributed to individual *definitions*:

```python
for src in G.nodes:
    src_rank = ranked[src]
    total_weight = sum(edge weights out of src)
    for each edge (src -> dst):
        definition_rank[dst, ident] += src_rank * edge_weight / total_weight
```

This gives a per-file, per-identifier rank score. Definitions are then sorted by `(rank, (fname, ident))` descending.

### 1.3 Budget Fitting: Binary Search on Tag Count

**Algorithm in `get_ranked_tags_map_uncached`:**

```python
lower_bound = 0
upper_bound = num_tags
middle = min(max_map_tokens // 25, num_tags)  # initial guess: ~25 tokens per tag

while lower_bound <= upper_bound:
    tree = to_tree(ranked_tags[:middle])
    num_tokens = token_count(tree)

    pct_err = abs(num_tokens - max_map_tokens) / max_map_tokens
    ok_err = 0.15  # 15% tolerance

    if (num_tokens <= max_map_tokens and num_tokens > best_tree_tokens) or pct_err < ok_err:
        best_tree = tree
        if pct_err < ok_err:
            break

    if num_tokens < max_map_tokens:
        lower_bound = middle + 1
    else:
        upper_bound = middle - 1
    middle = (lower_bound + upper_bound) // 2
```

**Key details:**
- **Not greedy.** It's a **binary search** on the number of tags to include.
- Initial midpoint estimate: `max_map_tokens // 25` (rough estimate of 25 tokens per tag entry).
- Acceptance: stops early if within 15% error of target, or keeps best sub-target fit.
- The sorted tags list is the PageRank-ranked definition list — highest rank first.

**Token counting:** For text > 200 chars, uses **sampling**: takes every Nth line (N = num_lines // 100), tokenizes the sample, and extrapolates. This avoids tokenizing the full tree output every iteration.

### 1.4 Dynamic Map Adjustment

**When chat files are present:**
- `map_mul_no_files` (default 8) multiplier: when no files are in chat, `max_map_tokens` is expanded up to `max_context_window - 4096` or `max_map_tokens * 8`, giving a wider view.
- When files ARE in chat, the base `max_map_tokens` is used, and chat files are excluded from the output (their definitions are already available as file content).

**Refresh strategies (configurable `--auto-refresh`):**
- `"auto"`: Rebuilds only if `map_processing_time > 1.0s` and cache key changed.
- `"always"`: Rebuilds every turn.
- `"files"`: Uses cache for the same file set.
- `"manual"`: Returns last computed map.

**Cache key:** `(sorted(chat_fnames), sorted(other_fnames), max_map_tokens, mentioned_fnames, mentioned_idents)` — changes when conversation context changes.

**Mentioned idents/fnames:** Extracted from user messages by simple string matching. When a user says "fix the UserService class", `UserService` becomes a mentioned ident, boosting its rank ×10 and boosting any file with that name component in its path.

### 1.5 Tree Rendering (What the LLM Sees)

**`to_tree()` + `render_tree()`:**

For each file, Aider uses `grep_ast.TreeContext` to render only the **lines of interest** (definition lines) with their surrounding scope context (parent class/function). This is NOT full file content — it's a context-aware excerpt:

```python
context = TreeContext(rel_fname, code, color=False, line_number=False,
                      child_context=False, last_line=False, margin=0,
                      mark_lois=False, loi_pad=0, show_top_of_file_parent_scope=False)
context.lines_of_interest = set(lois)  # line numbers of definitions
context.add_context()
result = context.format()
```

Output format: `path/to/file.py:\n<excerpted context around definitions>\n`

Lines are truncated to 100 chars. Files without tags are listed by name only (no content).

### 1.6 Tree-Sitter Languages/Parsers

Uses `tree-sitter-language-pack` (primary) or `tree-sitter-languages` (fallback), plus per-language `.scm` query files in `aider/queries/`. Supports 100+ languages. The queries use capture groups `name.definition.*` and `name.reference.*` which map to tree-sitter node types per language.

### 1.7 Incrementality

**NOT truly incremental across turns.** Each rebuild:
1. Reads all file mtimes from the disk cache.
2. Only re-parses files whose mtime changed (cache invalidation by mtime).
3. Rebuilds the entire graph and reruns PageRank from scratch.
4. However, the graph construction is fast because most tags are cached.

The **incrementality comes from the disk cache**, not from incremental graph updates.

---

## 2. SERENA

### 2.1 Symbol Lookup Mechanism

**Architecture:** Serena runs **real language servers** (via `solidlsp` library, a Python LSP client wrapper) — not a custom index.

- `LanguageServerManager` manages one or more `SolidLanguageServer` instances per project.
- `LanguageServerFactory` creates servers using LSP configs per language.
- Each language server is started in a separate thread.
- File-system changes are synced via `workspace/didChangeWatchedFiles` LSP notifications (polled before symbolic tool calls).

**Symbol retrieval:**
```python
# LanguageServerSymbolRetriever.find()
for lang_server in self._ls_manager.iter_language_servers():
    symbol_roots = lang_server.request_full_symbol_tree(within_relative_path)
    for root in symbol_roots:
        symbols.extend(LanguageServerSymbol(root).find(pattern, ...))
```

- Calls `request_full_symbol_tree()` on the LSP server, which returns the full document symbol tree (nested `UnifiedSymbolInformation`).
- Matching is done via `NamePathMatcher` — supports exact, suffix, and substring matching on hierarchical name paths (e.g., `MyClass/my_method[0]`).

**Reference discovery:**
```python
lang_server.request_referencing_symbols(relative_file_path, line, column, ...)
```
Delegates directly to LSP `textDocument/references` and wraps results as `ReferenceInLanguageServerSymbol`.

**Implementation lookup:**
```python
lang_server.request_implementing_symbols(relative_file_path, line, column, ...)
```
Uses LSP `textDocument/implementation`.

**Declaration lookup:**
```python
lang_server.request_defining_symbol(relative_file_path, line, column, ...)
```
Uses LSP `textDocument/definition`.

### 2.2 Targeted Edits (Avoiding Whole-File Reads)

**CodeEditor hierarchy:**

- `CodeEditor` (abstract base) → `LanguageServerCodeEditor` (LSP) / `JetBrainsCodeEditor` (JetBrains plugin)
- Edits work on **symbol-level spans**, not whole files:

```python
def replace_body(self, name_path, relative_file_path, body):
    symbol = self._find_unique_symbol(name_path, relative_file_path)
    start_pos = symbol.get_body_start_position_or_raise()
    end_pos = symbol.get_body_end_position_or_raise()
    with self.edited_file_context(relative_file_path) as edited_file:
        edited_file.delete_text_between_positions(start_pos, end_pos)
        edited_file.insert_text_at_position(start_pos, body)
```

**Under the hood (LSP backend):**
- `delete_text_between_positions` → `lang_server.delete_text_between_positions(path, start, end)`
- `insert_text_at_position` → `lang_server.insert_text_at_position(path, line, col, text)`
- These use LSP `textDocument/didChange` with precise `TextEdit` operations.
- File is opened via `lang_server.open_file()` (LSP `textDocument/didOpen`) and saved on context exit (`textDocument/didSave`).

**Under the hood (JetBrains backend):**
- Reads file content into memory, applies in-place string manipulation via `TextUtils.delete_text_between_positions()` / `TextUtils.insert_text_at_position()`, then writes back to disk.
- After saving, notifies JetBrains plugin via `client.refresh_file()`.

**Rename via LSP:**
```python
lang_server.request_rename_symbol_edit(relative_file_path, line, column, new_name)
# Returns a WorkspaceEdit with documentChanges
```
Applied via `_apply_workspace_edit()` which handles both text edits and file renames.

### 2.3 MCP Tool Registration

Serena exposes tools via MCP. The tool list is generated from `ToolRegistry` (auto-discovered via `iter_subclasses(ToolMarker)`). Key tools:

| Tool Name | Category | What It Does |
|---|---|---|
| `find_symbol` | Read | Global search by name path pattern |
| `get_symbols_overview` | Read | File outline (top-level symbols) |
| `find_referencing_symbols` | Read | Find all references to a symbol |
| `find_implementations` | Read | Find implementing classes |
| `find_declaration` | Read | Go to definition at a code location |
| `replace_symbol_body` | Edit | Replace a symbol's full definition |
| `insert_after_symbol` | Edit | Insert code after a symbol |
| `insert_before_symbol` | Edit | Insert code before a symbol |
| `rename_symbol` | Edit | LSP-powered cross-file rename |
| `safe_delete_symbol` | Edit | Delete if no references |
| `read_file` | Basic | Read file or line range |
| `search_for_pattern` | Basic | Regex search across project |
| `replace_content` | Basic | Regex/literal find-replace in one file |
| `replace_in_files` | Basic | Multi-file find-replace with dry-run |
| `get_diagnostics_for_file` | Read | LSP diagnostics for a file |
| `get_diagnostics_for_symbol` | Read | LSP diagnostics scoped to a symbol |

Tool descriptions are Jinja2 templates rendered with available tool names. The system prompt is dynamically composed from context + modes + tools.

### 2.4 Per-Language Support / Index Format

**Language support:** 40+ languages via LSP servers (pyright, jdtls, rust-analyzer, gopls, clangd, etc.). Languages configured per-project in `project.yml` or `serena_config.yml`.

**Index format:** No custom serialization — relies entirely on the **live LSP server's in-memory index**:
- `request_full_symbol_tree()` → nested dict of `UnifiedSymbolInformation` (LSP DocumentSymbol)
- `request_referencing_symbols()` → list of `ReferenceInSymbol` (location + containing symbol)
- `request_overview()` → flattened symbol list per file
- `request_symbol_at_location()` → single symbol at cursor position

**No persistent serialized index.** The LSP server maintains its own index (typically in memory or in its own cache directory). Serena queries it live on each tool call.

**Hover info (docstrings/signatures):**
```python
lang_server.request_hover(relative_file_path, line, column, file_buffer)
```
Batch retrieval with a **time budget** (`symbol_info_budget`, default 5s) — groups by file, stops when budget exceeded.

---

## 3. COMPARISON & REUSABILITY FOR MIZI

### 3.1 What Each Preserves vs. What's Lossy

| Aspect | Aider Repo-Map | Serena |
|---|---|---|
| **Preserves** | Identifier names, file relationships, rank scores | Full symbol trees, bodies, references, types, diagnostics |
| **Loses** | Function bodies, types, control flow, imports | Nothing (live LSP — but query latency) |
| **Compression** | ~25 tokens/def (file name + context excerpt) | Full body on request; overview is name+kind only |
| **Staleness** | mtime-based disk cache; rebuilt per conversation | Live LSP; stale if file changed externally without notification |

### 3.2 Budget/Ranking Algorithm Details

**Aider:**
- Budget: token count (configurable via `--map-tokens`, default 1024)
- Ranking: NetworkX PageRank with personalization vector
- Fitting: Binary search on tag count, 15% error tolerance
- No per-language proportional allocation — all languages treated equally

**Serena:**
- No budget system — agent calls tools on demand
- No ranking — agent decides what to query
- Cost control: `max_answer_chars` parameter on tool results, progressive shortening (full → summary → count)

### 3.3 Directly Reusable / Inspiring for MIZI

**From Aider (highest impact for MIZI's token optimization):**

1. **The ranking approach:** MIZI already has a symbol graph + dependency edges. Aider's PageRank-with-personalization is directly applicable:
   - Personalization vector: files in the current session's working set get higher base rank
   - Mentioned identifiers (from user message) get ×10 boost
   - Chat-file references get ×50 boost
   - This is a **zero-cost signal** — MIZI already tracks which files are being edited

2. **The binary search budget fitting:** Given N ranked symbols, binary search for the largest prefix that fits a token budget. The `//25` initial guess and 15% tolerance are good defaults. MIZI could precompute token costs per symbol (signature + deps) and binary search.

3. **The `TreeContext` rendering approach:** Instead of sending full files, extract only the lines of interest + their parent scope context. MIZI's `code_chunks` could use a similar scope-aware extraction rather than naive chunking.

4. **The sublinear ref-count scaling:** `sqrt(num_refs)` prevents high-frequency references (e.g., `import`) from dominating the graph. MIZI should apply this to its dependency edge weights.

5. **Cache invalidation by mtime:** Simple, effective. MIZI's repo-indexer could adopt this for incremental graph updates instead of full rebuilds.

**From Serena (highest impact for MIZI's backend):**

1. **Symbol-level edit primitives as MCP tools:** `replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol` are excellent abstractions for coding agents. MIZI already has symbol-level info — expose these as first-class tools.

2. **The `NamePathMatcher` pattern:** Hierarchical name path matching (e.g., `MyClass/my_method[0]`) with suffix/exact/substring modes is a clean way to address symbols without requiring exact names. MIZI's symbol graph could adopt this addressing scheme.

3. **Budget-limited hover info retrieval:** The `symbol_info_batch` with a time budget (group by file, stop at 5s) is a smart pattern for when docstrings/signatures are expensive to retrieve. MIZI could apply this to any batch metadata retrieval.

4. **`max_answer_chars` with progressive shortening:** Every tool returns progressively shorter summaries when results exceed a character limit. This is a good pattern for MIZI's context injection — always return *something* rather than truncating.

5. **File change notification polling before symbolic queries:** `sync_file_system_changes()` detects external edits and notifies LSP before queries. MIZI's repo-indexer could poll for mtime changes before serving graph data.

### 3.4 Key Architectural Differences

| | Aider | Serena | MIZI (Current) |
|---|---|---|---|
| **Index** | tree-sitter tags + NetworkX graph | Live LSP server in-memory | Custom symbol graph + deps |
| **Query model** | Pre-built map injected into context | Agent queries on demand | Graph + chunks |
| **Token control** | Hard budget, binary search fit | No budget (tool-level shortening) | `TOKEN_MODE_PROFILES` |
| **Incrementality** | mtime-based cache | LSP live index | Per-phase rebuild |
| **Language coverage** | tree-sitter queries (100+) | LSP servers (40+) | Language-specific tasks (13) |

### 3.5 Concrete MIZI Integration Ideas

1. **Aider-style PageRank on MIZI's dependency graph:**
   - MIZI already has `repo-graph` with symbols + dependency edges
   - Add a `personalization` vector based on session working set
   - Run PageRank once, cache the ranked list
   - Binary search to fit top-N definitions into token budget per phase

2. **Serena-style symbolic edit tools via MCP:**
   - MIZI's `mizi-mcp-server` could expose `replace_symbol_body`, `insert_after_symbol` etc.
   - These map cleanly to MIZI's existing `code_chunks` + symbol spans
   - Agents would use these instead of `edit_file` with whole-file content

3. **Hybrid approach:**
   - Use Aider's ranking to pre-select relevant symbols (context injection)
   - Use Serena's on-demand queries for precise edits (tool calls)
   - MIZI's `TOKEN_MODE_PROFILES` would control how much rank-filtered context is injected vs. how many tool calls the agent makes

