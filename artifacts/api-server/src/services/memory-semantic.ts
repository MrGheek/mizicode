import { logger } from "../lib/logger";

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

export function tfidfCosineSimilarity(textA: string, textB: string): number {
  const tokenize = (s: string) => s.toLowerCase().split(/\W+/).filter(t => t.length > 2);
  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const tfA = new Map<string, number>();
  const tfB = new Map<string, number>();
  for (const t of tokensA) tfA.set(t, (tfA.get(t) ?? 0) + 1);
  for (const t of tokensB) tfB.set(t, (tfB.get(t) ?? 0) + 1);
  const vocab = new Set([...tfA.keys(), ...tfB.keys()]);
  const vecA: number[] = [];
  const vecB: number[] = [];
  for (const term of vocab) {
    vecA.push((tfA.get(term) ?? 0) / tokensA.length);
    vecB.push((tfB.get(term) ?? 0) / tokensB.length);
  }
  return cosineSimilarity(vecA, vecB);
}

/**
 * Compute semantic similarity scores between a source text and a batch of
 * candidate texts in a single embedding API call.
 *
 * Primary: embeds [source, ...candidates] in one request to the OpenAI
 * embeddings API (text-embedding-3-small) via AI_INTEGRATIONS_OPENAI_BASE_URL,
 * then returns the cosine similarity of source vs each candidate.
 *
 * Fallback: if the embeddings endpoint is unavailable or throws, falls back to
 * TF-IDF cosine similarity for every candidate pair without a network call.
 *
 * One network call regardless of the number of candidates (up to 50).
 * Only called when MIZI_MEM_SEMANTIC_CONTRADICTION=1 is set.
 */
export async function computeSemanticSimilarityBatch(
  source: string,
  candidates: string[],
): Promise<number[]> {
  if (candidates.length === 0) return [];

  const baseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  const apiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

  if (baseUrl && apiKey) {
    try {
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: [source, ...candidates],
        }),
      });

      if (response.ok) {
        const data = await response.json() as { data: Array<{ embedding: number[]; index: number }> };
        // Sort by index to guarantee ordering (the API may return out-of-order)
        const sorted = data.data.slice().sort((a, b) => a.index - b.index);
        const sourceEmb = sorted[0]?.embedding;
        if (sourceEmb && sorted.length === candidates.length + 1) {
          return sorted.slice(1).map(d => cosineSimilarity(sourceEmb, d.embedding));
        }
      } else {
        logger.debug(
          { status: response.status },
          "[mem] embeddings API returned non-OK, falling back to TF-IDF cosine",
        );
      }
    } catch (err) {
      logger.debug({ err }, "[mem] embeddings API call failed, falling back to TF-IDF cosine");
    }
  }

  // Fallback: TF-IDF cosine similarity per candidate (no network call)
  return candidates.map(c => tfidfCosineSimilarity(source, c));
}

/**
 * Single-pair convenience wrapper used in tests and wherever a one-off
 * comparison is needed. Delegates to the batch function.
 */
export async function computeSemanticSimilarity(textA: string, textB: string): Promise<number> {
  const [score] = await computeSemanticSimilarityBatch(textA, [textB]);
  return score ?? 0;
}
