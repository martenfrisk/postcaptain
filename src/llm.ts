/**
 * Local LLM access via Ollama (design §8: the characterizer runs entirely on a
 * local model — raw prompts/code may be sent here because nothing leaves the
 * machine). The client is an interface so callers can inject a fake in tests.
 *
 * The one *remote* call in the design — the weekly synthesis via Copilot CLI —
 * is deliberately not here; it lives behind the redaction gate and is unrelated
 * to this local client.
 */

export interface GenerateOpts {
  system?: string;
  /** Ask the model to emit strict JSON (`format: "json"`). */
  json?: boolean;
  temperature?: number;
}

export interface LlmClient {
  generate(prompt: string, opts?: GenerateOpts): Promise<string>;
  embed(text: string): Promise<number[]>;
}

export interface OllamaOptions {
  model?: string;
  embedModel?: string;
  host?: string;
}

const DEFAULT_HOST = "http://localhost:11434";
const DEFAULT_MODEL = "llama3.2:latest";
const DEFAULT_EMBED_MODEL = "nomic-embed-text:latest";

/** An {@link LlmClient} backed by a local Ollama server. */
export function ollamaClient(opts: OllamaOptions = {}): LlmClient {
  const host = opts.host ?? DEFAULT_HOST;
  const model = opts.model ?? DEFAULT_MODEL;
  const embedModel = opts.embedModel ?? DEFAULT_EMBED_MODEL;

  return {
    async generate(prompt, o = {}) {
      const res = await fetch(`${host}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          system: o.system,
          stream: false,
          think: false, // suppress reasoning models' scratchpad
          format: o.json ? "json" : undefined,
          options: { temperature: o.temperature ?? 0 },
        }),
      });
      if (!res.ok) throw new Error(`ollama generate failed: ${res.status} ${res.statusText}`);
      const data = (await res.json()) as { response?: string };
      return data.response ?? "";
    },

    async embed(text) {
      const res = await fetch(`${host}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: embedModel, prompt: text }),
      });
      if (!res.ok) throw new Error(`ollama embeddings failed: ${res.status} ${res.statusText}`);
      const data = (await res.json()) as { embedding?: number[] };
      return data.embedding ?? [];
    },
  };
}

/** Cosine distance (1 − cosine similarity) for the novelty gate (§6). */
export function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}
