// api/retrieval.js
import OpenAI from 'openai';
import fs from 'fs';
import {
  OPENAI_API_KEY,
  OPENAI_VECTOR_STORE,
  OPENAI_ASSISTANT_ID,
  OPENAI_MODEL,
} from '../config.js';

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

export async function uploadFileToVS(filePath, displayName) {
  if (!OPENAI_VECTOR_STORE) return null;
  const file = await client.files.create({ file: fs.createReadStream(filePath), purpose: 'assistants' });
  await client.beta.vectorStores.files.create(OPENAI_VECTOR_STORE, { file_id: file.id });
  return file.id;
}

export async function askWithVS(prompt) {
  if (!OPENAI_VECTOR_STORE) throw new Error('OPENAI_VECTOR_STORE is not configured');

  // If assistant is provided, use Assistants Threads + Runs
  if (OPENAI_ASSISTANT_ID) {
    const thread = await client.beta.threads.create({
      tool_resources: { file_search: { vector_store_ids: [OPENAI_VECTOR_STORE] } },
    });
    await client.beta.threads.messages.create(thread.id, { role: 'user', content: prompt });
    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: OPENAI_ASSISTANT_ID,
      tools: [{ type: 'file_search' }],
    });
    let status = run.status;
    while (!['completed', 'failed', 'cancelled', 'expired'].includes(status)) {
      await new Promise((r) => setTimeout(r, 2000));
      const rn = await client.beta.threads.runs.retrieve(thread.id, run.id);
      status = rn.status;
    }
    if (status !== 'completed') throw new Error(`Retrieval run not completed: ${status}`);
    const { data } = await client.beta.threads.messages.list(thread.id, { limit: 1, order: 'desc' });
    const last = data[0];
    const text = last?.content?.map((c) => c.text?.value || '').join('\n').trim();
    return text;
  }

  // Fallback: Responses API with attachments to Vector Store (no assistant needed)
  const response = await client.responses.create({
    model: OPENAI_MODEL || 'gpt-4o-mini',
    input: prompt,
    attachments: [
      { file_search: { vector_store_ids: [OPENAI_VECTOR_STORE] } },
    ],
  });
  return response.output_text || response.output?.[0]?.content?.map?.((c)=>c.text?.value||'').join('\n') || '';
} 