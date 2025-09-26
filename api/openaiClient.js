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
    const attemptStart = Date.now();
    try {
      if (req?.metadata) {
        try {
          console.info(JSON.stringify({
            event: "openai_request_start",
            attempt: i + 1,
            model: req?.model,
            metadata: req.metadata,
          }));
        } catch {}
      }
      const response = await openai.responses.create(req);
      if (req?.metadata) {
        try {
          console.info(JSON.stringify({
            event: "openai_request_success",
            attempt: i + 1,
            model: req?.model,
            durationMs: Date.now() - attemptStart,
            metadata: req.metadata,
          }));
        } catch {}
      }
      return response;
    } catch (err) {
      lastErr = err;
      const status = err?.status || err?.code || 0;
      const retriable = status === 429 || (status >= 500 && status < 600);
      try {
        console.warn(JSON.stringify({
          event: "openai_request_error",
          attempt: i + 1,
          model: req?.model,
          status,
          message: err?.message || String(err),
          metadata: req?.metadata || null,
        }));
      } catch {}
      if (!retriable) break;
      const backoff = 200 * Math.pow(3, i); // 200ms, 600ms, 1800ms
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

export async function chatCompletion(messages, metadata = null) {
  if (!openai) throw new Error("OPENAI_API_KEY not configured");
  const input = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
  const req = {
    model: OPENAI_MODEL,
    input,
    max_output_tokens: OPENAI_MAX_TOKENS,
  };
  if (metadata) req.metadata = metadata;
  const response = await callResponsesWithRetry(req);
  const text = response.output_text || response.output?.map?.(p=>p?.content?.map?.(c=>c?.text?.value||"").join("")).join("\n");
  return text || "{}";
}

// New: per-call overrides for model/temperature/max_output_tokens
export async function chatCompletionWithOpts(messages, opts = {}, metadata = null) {
  if (!openai) throw new Error("OPENAI_API_KEY not configured");
  const input = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
  const req = {
    model: opts.model || OPENAI_MODEL,
    input,
  };
  if (typeof opts.temperature === 'number') req.temperature = opts.temperature;
  if (typeof opts.max_output_tokens === 'number') req.max_output_tokens = opts.max_output_tokens;
  const meta = opts.metadata || metadata;
  if (meta) req.metadata = meta;
  const response = await callResponsesWithRetry(req);
  const text = response.output_text || response.output?.map?.(p=>p?.content?.map?.(c=>c?.text?.value||"").join("")).join("\n");
  return text || "{}";
}

export default openai; 