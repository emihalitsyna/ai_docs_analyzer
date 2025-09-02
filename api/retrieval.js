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

async function ensureVectorStoreId(providedId) {
  if (providedId) {
    try {
      // Verify the vector store exists
      await client.vectorStores.retrieve(providedId);
      return providedId;
    } catch (err) {
      // If not found or invalid, fall through to create a new one
    }
  }
  // Auto-create a Vector Store if none provided or invalid
  const vs = await client.vectorStores.create({ name: 'doc-analyzer-vs' });
  return vs.id;
}

export async function uploadFileToVS(filePath, displayName, contentType, vectorStoreId = OPENAI_VECTOR_STORE) {
  const vsId = await ensureVectorStoreId(vectorStoreId);
  if (!vsId) {
    throw new Error('Vector Store ID is not defined and could not be created');
  }
  const fileForUpload = await OpenAI.toFile(fs.createReadStream(filePath), displayName, contentType ? { contentType } : undefined);
  // Use batch upload with built-in polling
  await client.vectorStores.fileBatches.uploadAndPoll(vsId, { files: [fileForUpload] });
  return { vectorStoreId: vsId };
}

export async function askWithVS(prompt, vectorStoreId = OPENAI_VECTOR_STORE) {
  const vsId = await ensureVectorStoreId(vectorStoreId);

  // If assistant is provided, use Assistants Threads + Runs
  if (OPENAI_ASSISTANT_ID) {
    const thread = await client.beta.threads.create({
      tool_resources: { file_search: { vector_store_ids: [vsId] } },
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
    return { text, meta: { mode: 'assistants', threadId, runId: run?.id || null, vectorStoreId: vsId } };
  }

  // Fallback: Responses API with attachments to Vector Store (no assistant needed)
  const response = await client.responses.create({
    model: OPENAI_MODEL || 'gpt-4o-mini',
    input: prompt,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    attachments: [
      { file_search: { vector_store_ids: [vsId] } },
    ],
  });
  const text = response.output_text || response.output?.[0]?.content?.map?.((c)=>c.text?.value||'').join('\n') || '';
  return { text, meta: { mode: 'responses', responseId: response.id, vectorStoreId: vsId } };
} 