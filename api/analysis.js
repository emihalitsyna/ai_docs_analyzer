// api/analysis.js
import fs from "fs";
import path from "path";
import chunkText from "./chunker.js";
import { embedChunks, chatCompletion } from "./openaiClient.js";
import { askWithVS } from "./retrieval.js";
import { OPENAI_VECTOR_STORE } from "../config.js";
import {
  CHUNK_SIZE,
  CHUNK_OVERLAP,
} from "../config.js";

export const SYSTEM_PROMPT = `Ты эксперт по тендерам и аналитик требований.
Цель: провести детальный, но компактный анализ. Строго опирайся на текст документа. Если информации нет — верни пустые поля.
Каждое требование формулируй конкретно и добавляй цитату-источник.
Стремись к 5–12 осмысленным пунктам в разделах требований.

Верни ЧИСТЫЙ JSON-объект (без пояснений и форматирования кода) следующей структуры и с этими ключами:
{
  "наименование_компании_заказчика": string | string[],
  "описание_документа": string,                       // краткое резюме 2–4 предложения
  "ссылка_на_оригинальное_тз": string,               // URL, если указан; иначе пустая строка
  "контактные_лица": [
    { "фио": string, "роль": string, "email": string, "телефон": string }
  ],

  "технические_требования": [ { "описание": string, "цитата": string } ],
  "функциональные_требования": [ { "описание": string, "цитата": string } ],
  "нефункциональные_требования": [ { "описание": string, "цитата": string } ],
  "инфраструктурные_требования": [ { "описание": string, "цитата": string } ],
  "ограничения_и_риски": [ { "описание": string, "цитата": string } ],
  "сроки_реализации_и_стоимость_проекта": string | string[],

  "необходимые_документы_и_поля": [
    { "документ": string, "поля": string[] }
  ],

  "требуемые_доработки": [
    { "описание": string, "приоритет": "Высокий" | "Средний" | "Низкий", "оценка_сложности": "L" | "M" | "H", "цитата": string }
  ],

  "сопоставление_с_dbrain": [
    { "требование": string, "статус": "Поддерживается" | "Частично" | "Не_поддерживается", "комментарий": string, "цитата": string }
  ]
}

Правила:
- Если раздел присутствует в документе — верни 6–12 пунктов, где уместно; иначе — пустой массив/строку.
- Все цитаты должны быть дословными фрагментами из документа (краткими).
- Не выдумывай контакты/URL/стоимость/сроки/соответствие Dbrain — оставляй пусто, если нет в тексте.
- Если знаний о возможностях Dbrain не предоставлено во входных данных — разделы "требуемые_доработки" и "сопоставление_с_dbrain" формируй только из формулировок документа (без предположений).`;

export default async function analyzeDocument(text, originalName) {
  if (OPENAI_VECTOR_STORE) {
    // Retrieval-first: we rely on Vector Store + Assistant/Responses file_search
    const { text: out } = await askWithVS(SYSTEM_PROMPT);
    return out;
  }
  // Heuristic: if text length < 15k chars treat as small
  if (text.length < 15000) {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
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
    { role: "system", content: SYSTEM_PROMPT },
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