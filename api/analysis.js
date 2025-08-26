// api/analysis.js
import fs from "fs";
import path from "path";
import chunkText from "./chunker.js";
import { embedChunks, chatCompletion } from "./openaiClient.js";
import {
  CHUNK_SIZE,
  CHUNK_OVERLAP,
} from "../config.js";

const SYSTEM_PROMPT = `Ты эксперт по тендерам и аналитик требований.
Цель: провести детальный, но компактный анализ.
Ориентируйся на формулировки заказчика.
Каждое требование формулируй конкретно.
Для каждого пункта добавляй цитату.
Если информации нет — не выдумывай.
Стремись к 5–12 осмысленным пунктам.

Структура анализа:
0. Наименование компании заказчика
1. Технические требования
2. Функциональные требования
3. Нефункциональные требования
4. Инфраструктурные требования
5. Ограничения и риски
6. Сроки реализации и стоимость проекта
7. Необходимые документы и поля (как { "документ": "…", "поля": ["…"] })

Формат ответа — читаемый JSON без лишних деталей. Если информации нет, возвращать пустой список или пустую строку.`;

export default async function analyzeDocument(text, originalName) {
  // Heuristic: if text length < 15k chars treat as small
  if (text.length < 15000) {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ];
    const jsonStr = await chatCompletion(messages);
    return jsonStr;
  }

  // Retrieval mode
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
  const dir = path.join(path.resolve(), "backend/analysis_results");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, safeName);
  fs.writeFileSync(filePath, jsonStr, "utf-8");
  return safeName;
} 