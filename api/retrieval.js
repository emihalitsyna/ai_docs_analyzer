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
  const file = await client.files.create({ file: fs.createReadStream(filePath), purpose: 'assistants', filename: displayName });
  const vsFile = await client.beta.vectorStores.files.create(OPENAI_VECTOR_STORE, { file_id: file.id });
  const vsFileId = vsFile.id || file.id;
  // Poll until indexing completed
  let status = 'in_progress';
  let attempts = 0;
  while (status !== 'completed' && attempts < 60) { // ~60s max
    await new Promise((r) => setTimeout(r, 1000));
    const f = await client.beta.vectorStores.files.retrieve(OPENAI_VECTOR_STORE, vsFileId);
    status = f.status;
    attempts += 1;
  }
  return vsFileId;
}

export async function askWithVS(prompt) {
  if (!OPENAI_VECTOR_STORE) throw new Error('OPENAI_VECTOR_STORE is not configured');

  // If assistant is provided, use Assistants Threads + Runs
  if (OPENAI_ASSISTANT_ID) {
    const thread = await client.beta.threads.create({
      tool_resources: { file_search: { vector_store_ids: [OPENAI_VECTOR_STORE] } },
    });
    const threadId = thread?.id;
    if (!threadId) throw new Error('Failed to create thread (no id)');
    await client.beta.threads.messages.create(threadId, { role: 'user', content: prompt });
    const run = await client.beta.threads.runs.createAndPoll(threadId, {
      assistant_id: OPENAI_ASSISTANT_ID,
      tools: [{ type: 'file_search' }],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });
    if (run.status !== 'completed') {
      throw new Error(`Retrieval run not completed: ${run.status} (thread=${threadId}, run=${run?.id || 'unknown'})`);
    }
    const { data } = await client.beta.threads.messages.list(threadId, { limit: 1, order: 'desc' });
    const last = data[0];
    const text = last?.content?.map((c) => c.text?.value || '').join('\n').trim();
    return { text, meta: { mode: 'assistants', threadId, runId: run?.id || null, vectorStoreId: OPENAI_VECTOR_STORE } };
  }

  // Fallback: Responses API with attachments to Vector Store (no assistant needed)
  const response = await client.responses.create({
    model: OPENAI_MODEL || 'gpt-4o-mini',
    input: prompt,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    attachments: [
      { file_search: { vector_store_ids: [OPENAI_VECTOR_STORE] } },
    ],
  });
  const text = response.output_text || response.output?.[0]?.content?.map?.((c)=>c.text?.value||'').join('\n') || '';
  return { text, meta: { mode: 'responses', responseId: response.id, vectorStoreId: OPENAI_VECTOR_STORE } };
} 