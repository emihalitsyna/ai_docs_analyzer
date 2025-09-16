
// api/analysis.js
import fs from "fs";
import path from "path";
import chunkText from "./chunker.js";
import { embedChunks, chatCompletion } from "./openaiClient.js";
import { chatCompletionWithOpts } from "./openaiClient.js";
import { askWithVS } from "./retrieval.js";
import { OPENAI_VECTOR_STORE, DBRAIN_KB_PATH } from "../config.js";
import {
  CHUNK_SIZE,
  CHUNK_OVERLAP,
} from "../config.js";

export const SYSTEM_PROMPT = `Ты эксперт по тендерной документации и аналитик требований.
Твоя задача — провести полный анализ всего документа целиком, не ограничиваясь частями.
Извлеки из документа всю значимую информацию и оформи её в удобочитаемом виде, чтобы результат можно было сразу поместить в карточку Notion.

СТРОГО используй следующие разделы и их заголовки (1–7) в указанном порядке.
Не используй технические форматы (JSON, Markdown, разметку). Просто верни чистый текст со списками.
Если информации по разделу нет — оставь этот раздел пустым.

1. Описание проекта
Кратко укажи, что это за проект, для кого он предназначен и с какой целью.

2. Типы документов на обработку
Перечисли, какие документы или данные требуется обрабатывать.

3. Требования
Представь списками по группам:
- Технические требования
- Функциональные требования
- Нефункциональные требования
- Инфраструктурные требования
- Ограничения и риски

4. Список необходимых доработок
Сравни выявленные требования с возможностями продукта Dbrain (используй документацию Dbrain, если она доступна).
Укажи, какие пункты уже покрываются, какие требуют доработок, а какие не реализуются в текущем виде.

5. Контактные лица и способы связи
Перечисли всех, кто указан в документе с указанием должностей, телефонов, e-mail.

6. Ссылки и файлы
Укажи все ссылки и вложенные материалы, присутствующие в документе.

7. Оригинал ТЗ
Добавь отметку или ссылку на исходный файл ТЗ, который был загружен для анализа.`;

const CHUNK_PROMPT_SUFFIX = `Ты видишь фрагмент большого документа. Обрабатывай только явную информацию из фрагмента. Возвращай текст в тех же разделах 1–7. Никаких JSON/Markdown.`;

function readDbrainKB() {
  try {
    if (DBRAIN_KB_PATH && fs.existsSync(DBRAIN_KB_PATH)) {
      const raw = fs.readFileSync(DBRAIN_KB_PATH, 'utf-8');
      const json = JSON.parse(raw);
      return json;
    }
  } catch {}
  return null;
}

export function buildPromptWithKB(basePrompt) {
  const kb = readDbrainKB();
  if (!kb) return basePrompt;
  const kbText = JSON.stringify(kb);
  return `${basePrompt}\n\nПодсказка по возможностям Dbrain (используй только для пункта 4, без выдумывания фактов):\n${kbText}`;
}

function safeParseJson(possible) {
  try { return JSON.parse(possible); } catch {}
  try {
    let cleaned = String(possible).replace(/^```[a-zA-Z]*[\s\r\n]+/i, "").replace(/```\s*$/i, "").trim();
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last !== -1) cleaned = cleaned.slice(first, last + 1);
    cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(cleaned);
  } catch { return null; }
}

function mergeUniqueStringArrays(a, b, limit = 12) {
  const set = new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].filter(Boolean).map((s) => String(s).trim()).filter(Boolean));
  return Array.from(set).slice(0, limit);
}

function mergeObjectItemArrays(a, b, key = 'описание', limit = 12) {
  const norm = (arr) => (Array.isArray(arr) ? arr : []).map((x) => (x && typeof x === 'object') ? x : { [key]: String(x) });
  const map = new Map();
  for (const it of norm(a).concat(norm(b))) {
    const k = (it[key] || '').trim();
    if (!k) continue;
    if (!map.has(k)) map.set(k, it);
  }
  return Array.from(map.values()).slice(0, limit);
}

function reduceAnalyses(partials) {
  // Для текстового формата просто конкатенируем разделы в порядке 1–7
  const pick = (text) => (typeof text === 'string' ? text.trim() : '');
  const join = (arr) => arr.filter(Boolean).join('\n');
  const res = { one: [], two: [], three: [], four: [], five: [], six: [], seven: [] };
  for (const p of partials) {
    const s = pick(p);
    if (!s) continue;
    // не зная структуры, просто добавим
    res.one.push(s);
  }
  return join([join(res.one), join(res.two), join(res.three), join(res.four), join(res.five), join(res.six), join(res.seven)]);
}

export default async function analyzeDocument(text, originalName) {
  const PROMPT = buildPromptWithKB(SYSTEM_PROMPT);
  // Всегда анализируем исходный текст; Retrieval не используем для финального анализа
  if (text.length < 15000) {
    const messages = [
      { role: "system", content: PROMPT },
      { role: "user", content: text },
    ];
    const out = await chatCompletion(messages);
    return out;
  }

  // Full-document map-reduce across all chunks (no Vector Store)
  const chunks = chunkText(text);
  const usedChunks = chunks; // анализируем все чанки

  const partials = [];
  for (let i = 0; i < usedChunks.length; i++) {
    const part = usedChunks[i];
    const messages = [
      { role: "system", content: `${PROMPT}\n\n${CHUNK_PROMPT_SUFFIX}` },
      { role: "user", content: part },
    ];
    try {
      const resp = await chatCompletion(messages);
      partials.push(resp);
    } catch {}
  }

  const reduced = reduceAnalyses(partials);
  return reduced || partials.join('\n');
}

export async function analyzeDocumentFull(text, originalName){
  const PROMPT = buildPromptWithKB(SYSTEM_PROMPT);
  const messages = [
    { role: "system", content: PROMPT },
    { role: "user", content: text },
  ];
  // Full-text single-call analysis with GPT-5, temperature=1, no explicit token cap
  const out = await chatCompletionWithOpts(messages, { model: 'gpt-5', temperature: 1 });
  return out;
}

export function saveAnalysis(jsonStr, originalName) {
  const safeName = `${path.parse(originalName).name}_${Date.now()}.json`;
  const dir = path.join("/tmp", "analysis_results");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, safeName);
  fs.writeFileSync(filePath, jsonStr, "utf-8");
  return safeName;
} 