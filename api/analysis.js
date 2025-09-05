// api/analysis.js
import fs from "fs";
import path from "path";
import chunkText from "./chunker.js";
import { embedChunks, chatCompletion } from "./openaiClient.js";
import { askWithVS } from "./retrieval.js";
import { OPENAI_VECTOR_STORE, DBRAIN_KB_PATH } from "../config.js";
import {
  CHUNK_SIZE,
  CHUNK_OVERLAP,
} from "../config.js";

export const SYSTEM_PROMPT = `Ты эксперт по тендерам и аналитик требований.
Цель: провести детальный, но компактный анализ. Строго опирайся на текст документа и знания о Dbrain (если они даны). Если информации нет — верни пустые поля.

Требования к разделу "описание_документа":
- Дай 3–4 предложения о самом проекте (контекст, цель внедрения, ключевые ограничения).
- В конце описания кратко перечисли ключевые требования одной-двумя фразами (свод).

Раздел "требуемые_доработки":
- Сначала сравни требования из документа с возможностями Dbrain из предоставленного KB.
- Включай сюда только то, чего НЕТ в KB Dbrain (или явно ограничено), без предположений.

Верни ЧИСТЫЙ JSON-объект (без пояснений и форматирования кода) следующей структуры и с этими ключами:
{
  "наименование_компании_заказчика": string | string[],
  "описание_документа": string,
  "ссылка_на_оригинальное_тз": string,
  "контактные_лица": [ { "фио": string, "роль": string, "email": string, "телефон": string } ],

  "технические_требования": [ { "описание": string, "цитата": string } ],
  "функциональные_требования": [ { "описание": string, "цитата": string } ],
  "нефункциональные_требования": [ { "описание": string, "цитата": string } ],
  "инфраструктурные_требования": [ { "описание": string, "цитата": string } ],
  "ограничения_и_риски": [ { "описание": string, "цитата": string } ],
  "сроки_реализации_и_стоимость_проекта": string | string[],

  "необходимые_документы_и_поля": [ { "документ": string, "поля": string[] } ],

  "требуемые_доработки": [ { "описание": string, "приоритет": "Высокий" | "Средний" | "Низкий", "оценка_сложности": "L" | "M" | "H", "цитата": string } ],

  "сопоставление_с_dbrain": [ { "требование": string, "статус": "Поддерживается" | "Частично" | "Не_поддерживается", "комментарий": string, "цитата": string } ]
}

Правила:
- Если раздел присутствует — верни 6–12 осмысленных пунктов, где уместно; иначе — пустой массив/строку.
- Все цитаты — дословные короткие фрагменты из документа.
- Не выдумывай контакты/URL/стоимость/сроки/соответствие Dbrain — оставляй пусто, если нет в тексте.`;

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

function buildPromptWithKB(basePrompt) {
  const kb = readDbrainKB();
  if (!kb) return basePrompt;
  const kbText = JSON.stringify(kb);
  return `${basePrompt}\n\nКонтекст о возможностях Dbrain (используй только для сопоставления и поиска доработок, не выдумывай факты):\n${kbText}`;
}

export default async function analyzeDocument(text, originalName) {
  const PROMPT = buildPromptWithKB(SYSTEM_PROMPT);
  if (OPENAI_VECTOR_STORE) {
    // Retrieval-first: we rely on Vector Store + Assistant/Responses file_search
    const { text: out } = await askWithVS(PROMPT);
    return out;
  }
  // Heuristic: if text length < 15k chars treat as small
  if (text.length < 15000) {
    const messages = [
      { role: "system", content: PROMPT },
      { role: "user", content: text },
    ];
    const jsonStr = await chatCompletion(messages);
    return jsonStr;
  }

  // Retrieval-like classic path for big texts (no VS)
  const chunks = chunkText(text);
  const embeddings = await embedChunks(chunks);
  // For MVP: just take first 10 chunks (could implement similarity search later)
  const selectedChunks = chunks.slice(0, 10);
  const messages = [
    { role: "system", content: PROMPT },
    { role: "user", content: selectedChunks.join("\n\n") },
  ];
  const jsonStr = await chatCompletion(messages);
  return jsonStr;
}

export function saveAnalysis(jsonStr, originalName) {
  const safeName = `${path.parse(originalName).name}_${Date.now()}.json`;
  const dir = path.join("/tmp", "analysis_results");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, safeName);
  fs.writeFileSync(filePath, jsonStr, "utf-8");
  return safeName;
} 