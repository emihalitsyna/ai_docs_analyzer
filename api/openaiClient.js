// api/openaiClient.js
import OpenAI from "openai";
import {
  OPENAI_API_KEY,
  OPENAI_MODEL,
  OPENAI_MAX_TOKENS,
  OPENAI_TEMPERATURE,
} from "../config.js";

let openai = null;

if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
}

export async function embedChunks(chunks) {
  if (!openai) throw new Error("OPENAI_API_KEY not configured");
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: chunks,
  });
  return response.data.map((d) => d.embedding);
}

async function callResponsesWithRetry(req, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await openai.responses.create(req);
    } catch (err) {
      lastErr = err;
      const status = err?.status || err?.code || 0;
      const retriable = status === 429 || (status >= 500 && status < 600);
      if (!retriable) break;
      const backoff = 200 * Math.pow(3, i); // 200ms, 600ms, 1800ms
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

export async function chatCompletion(messages) {
  if (!openai) throw new Error("OPENAI_API_KEY not configured");
  const input = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
  const response = await callResponsesWithRetry({
    model: OPENAI_MODEL,
    input,
    max_output_tokens: OPENAI_MAX_TOKENS,
  });
  const text = response.output_text || response.output?.map?.(p=>p?.content?.map?.(c=>c?.text?.value||"").join("")).join("\n");
  return text || "{}";
}

// New: per-call overrides for model/temperature/max_output_tokens
export async function chatCompletionWithOpts(messages, opts = {}) {
  if (!openai) throw new Error("OPENAI_API_KEY not configured");
  const input = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
  const req = {
    model: opts.model || OPENAI_MODEL,
    input,
  };
  if (typeof opts.temperature === 'number') req.temperature = opts.temperature;
  if (typeof opts.max_output_tokens === 'number') req.max_output_tokens = opts.max_output_tokens;
  const response = await callResponsesWithRetry(req);
  const text = response.output_text || response.output?.map?.(p=>p?.content?.map?.(c=>c?.text?.value||"").join("")).join("\n");
  return text || "{}";
}

export default openai; 