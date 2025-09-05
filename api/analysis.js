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

  "необходимые_документы_и_поля": [ { "документ": string, "поля": string[] } ],

  "требуемые_доработки": [ { "описание": string, "приоритет": "Высокий" | "Средний" | "Низкий", "оценка_сложности": "L" | "M" | "H", "цитата": string } ],

  "сопоставление_с_dbrain": [ { "требование": string, "статус": "Поддерживается" | "Частично" | "Не_поддерживается", "комментарий": string, "цитата": string } ]
}

Правила:
- Если раздел присутствует — верни 6–12 осмысленных пунктов, где уместно; иначе — пустой массив/строку.
- Все цитаты — дословные короткие фрагменты из документа.
- Не выдумывай контакты/URL/соответствие Dbrain — оставляй пусто, если нет в тексте.`;

const CHUNK_PROMPT_SUFFIX = `Ты видишь фрагмент большого документа. Извлеки ТОЛЬКО те данные, которые явно присутствуют в этом фрагменте. Не делай выводов по отсутствующим частям. Верни JSON ТОЧНО той же структуры, но оставляй пустые поля/массивы, если в этом фрагменте нет данных.`;

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
  const out = {};
  for (const p of partials) {
    if (!p || typeof p !== 'object') continue;
    // simple string fields
    if (!out["описание_документа"] && p["описание_документа"]) out["описание_документа"] = p["описание_документа"];
    if (!out["ссылка_на_оригинальное_тз"] && p["ссылка_на_оригинальное_тз"]) out["ссылка_на_оригинальное_тз"] = p["ссылка_на_оригинальное_тз"];
    if (!out["наименование_компании_заказчика"] && p["наименование_компании_заказчика"]) out["наименование_компании_заказчика"] = p["наименование_компании_заказчика"];

    // arrays of objects
    out["технические_требования"] = mergeObjectItemArrays(out["технические_требования"], p["технические_требования"]);
    out["функциональные_требования"] = mergeObjectItemArrays(out["функциональные_требования"], p["функциональные_требования"]);
    out["нефункциональные_требования"] = mergeObjectItemArrays(out["нефункциональные_требования"], p["нефункциональные_требования"]);
    out["инфраструктурные_требования"] = mergeObjectItemArrays(out["инфраструктурные_требования"], p["инфраструктурные_требования"]);
    out["ограничения_и_риски"] = mergeObjectItemArrays(out["ограничения_и_риски"], p["ограничения_и_риски"]);

    // contacts
    out["контактные_лица"] = mergeObjectItemArrays(out["контактные_лица"], p["контактные_лица"], 'фио');

    // docs and fields
    if (Array.isArray(p["необходимые_документы_и_поля"])) {
      const current = Array.isArray(out["необходимые_документы_и_поля"]) ? out["необходимые_документы_и_поля"] : [];
      const merged = [...current];
      const keyOf = (d) => (d && typeof d === 'object') ? (d.документ || d.название || d.name || JSON.stringify(d)) : String(d);
      const index = new Map(current.map((d) => [keyOf(d), d]));
      for (const d of p["необходимые_документы_и_поля"]) {
        const k = keyOf(d);
        if (!index.has(k)) { index.set(k, d); merged.push(d); }
      }
      out["необходимые_документы_и_поля"] = merged.slice(0, 20);
    }

    // do-works and mapping
    out["требуемые_доработки"] = mergeObjectItemArrays(out["требуемые_доработки"], p["требуемые_доработки"]);
    out["сопоставление_с_dbrain"] = mergeObjectItemArrays(out["сопоставление_с_dbrain"], p["сопоставление_с_dbrain"], 'требование');
  }
  return out;
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

  // Full-document map-reduce across all chunks (no Vector Store)
  const chunks = chunkText(text);
  const MAX_CHUNKS = 120; // защитный предел
  const usedChunks = chunks.slice(0, MAX_CHUNKS);

  const partials = [];
  for (let i = 0; i < usedChunks.length; i++) {
    const part = usedChunks[i];
    const messages = [
      { role: "system", content: `${PROMPT}\n\n${CHUNK_PROMPT_SUFFIX}` },
      { role: "user", content: part },
    ];
    try {
      const resp = await chatCompletion(messages);
      const obj = safeParseJson(resp);
      if (obj) partials.push(obj);
    } catch {}
  }

  const reduced = reduceAnalyses(partials);
  // Финальный выравнивающий проход: попросим модель привести в аккуратный вид (опционально)
  try {
    const messages = [
      { role: "system", content: PROMPT },
      { role: "user", content: `Сведи воедино и верни ЧИСТЫЙ JSON той же структуры из следующего результата: ${JSON.stringify(reduced)}` },
    ];
    const finalJson = await chatCompletion(messages);
    return finalJson;
  } catch {
    return JSON.stringify(reduced);
  }
}

export function saveAnalysis(jsonStr, originalName) {
  const safeName = `${path.parse(originalName).name}_${Date.now()}.json`;
  const dir = path.join("/tmp", "analysis_results");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, safeName);
  fs.writeFileSync(filePath, jsonStr, "utf-8");
  return safeName;
} 