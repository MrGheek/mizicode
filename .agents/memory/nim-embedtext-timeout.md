---
name: NIM embedText timeout in tests
description: NVIDIA_NIM_API_KEY present in Replit env causes embedText() to make real network calls; without a timeout this hangs tests.
---

## Rule
Always use `AbortSignal.timeout(300)` (or similar short value) on the NVIDIA NIM `/embeddings` fetch in `memory-passive.ts::embedText`.

**Why:** `NVIDIA_NIM_API_KEY` is a configured Replit secret, so `getAiConfig()` always returns non-null in this environment. Without a timeout, every `embedText` call blocks until the NIM API responds or the test's 15s watchdog fires. With many items in `backfillItemEmbeddings`, serial calls easily overflow the test budget.

**How to apply:**
- `embedText`: `signal: AbortSignal.timeout(300)` on the NIM fetch.
- `backfillItemEmbeddings`: pass `budgetMs` (default 30 000) so the loop breaks early when the wall-clock deadline is exceeded — protects production too.
- NIM should respond in <100ms when healthy; >300ms means overloaded/wrong key → fail fast and fall back gracefully.
