// api/openaiClient.js
import OpenAI from "openai";
import {
  OPENAI_API_KEY,
  OPENAI_MODEL,
  OPENAI_MAX_TOKENS,
  OPENAI_TEMPERATURE,
} from "../config.js";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

export async function embedChunks(chunks) {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: chunks,
  });
  return response.data.map((d) => d.embedding);
}

export async function chatCompletion(messages) {
  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: OPENAI_TEMPERATURE,
    max_tokens: OPENAI_MAX_TOKENS,
    messages,
  });
  return completion.choices[0].message.content;
}

export default openai; 