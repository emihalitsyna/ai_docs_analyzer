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

export async function chatCompletion(messages) {
  if (!openai) throw new Error("OPENAI_API_KEY not configured");
  const input = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input,
    temperature: OPENAI_TEMPERATURE,
    max_output_tokens: OPENAI_MAX_TOKENS,
  });
  const text = response.output_text || response.output?.map?.(p=>p?.content?.map?.(c=>c?.text?.value||"").join("")).join("\n");
  return text || "{}";
}

export default openai; 