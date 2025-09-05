// api/server.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import {
  OPENAI_API_KEY,
  NOTION_TOKEN,
  NOTION_DATABASE_ID,
  MAX_FILE_SIZE_BYTES,
  OPENAI_VECTOR_STORE,
  OPENAI_ASSISTANT_ID,
} from "../config.js";
import extractText from "./extractText.js";
import { uploadFileToVS } from "./retrieval.js";
import analyzeDocument, { saveAnalysis } from "./analysis.js";
import { Client as NotionClient } from "@notionhq/client";
import os from "os";
import cfgAll from "../config.js";
const { BLOB_READ_WRITE_TOKEN } = cfgAll;
const STATUS_DIR = "/tmp/notion_status";
if (!fs.existsSync(STATUS_DIR)) fs.mkdirSync(STATUS_DIR, { recursive: true });

function normalizeCompanyName(original) {
  if (!original) return "";
  let s = String(original).trim();
  // Если есть кавычки, берем содержимое
  const m = s.match(/[«“"']\s*([^«»“”"']+?)\s*[»”"']/);
  if (m && m[1]) s = m[1].trim();
  // Удаляем юр. формы в начале и в скобках
  const legalForms = [
    'общество с ограниченной ответственностью',
    'акционерное общество',
    'публичное акционерное общество',
    'закрытое акционерное общество',
    'открытое акционерное общество',
    'индивидуальный предприниматель',
    'ооо', 'ао', 'пао', 'зао', 'оао', 'ип'
  ];
  const reStart = new RegExp(`^(?:${legalForms.join('|')})\s+`, 'i');
  s = s.replace(reStart, '');
  // Удаляем повторы юр. форм в скобках
  s = s.replace(/\((?:[^()]*?(?:ооо|ао|пао|зао|оао|ип)[^()]*)\)/gi, '').trim();
  // Удаляем кавычки и лишние символы
  s = s.replace(/[«»"'“”]/g, '').trim();
  // Убираем хвосты типа ", ООО", " - ООО"
  s = s.replace(/[,\-]\s*(?:ооо|ао|пао|зао|оао|ип)\b/gi, '').trim();
  // Сжимаем пробелы
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s || String(original).trim();
}

async function uploadToBlob(filePath, remoteName, contentType) {
  try {
    if (!BLOB_READ_WRITE_TOKEN) return null;
    const { put } = await import('@vercel/blob');
    const buf = fs.readFileSync(filePath);
    const res = await put(`uploads/${Date.now()}_${remoteName}`, buf, { access: 'public', token: BLOB_READ_WRITE_TOKEN, contentType });
    return res?.url || null;
  } catch (e) {
    console.warn('blob_upload_failed', e?.message || e);
    return null;
  }
}

// Ensure Notion database has required properties
async function ensureNotionSchema(notion) {
  // Fetch DB
  const db = await notion.databases.retrieve({ database_id: NOTION_DATABASE_ID });
  const props = db.properties || {};
  const required = [
    { name: "Дата загрузки", type: "date" },
    { name: "Тип документа", type: "select", options: ["PDF", "DOCX"] },
    { name: "Статус", type: "select", options: ["Новый", "Готово", "Ошибка"] },
    { name: "Описание", type: "rich_text" },
    { name: "Ссылка на ТЗ", type: "url" },
    { name: "Контакты", type: "rich_text" },
    { name: "Доработки", type: "rich_text" },
    { name: "Сопоставление с Dbrain", type: "rich_text" },
  ];
  const update = { properties: {} };
  for (const r of required) {
    if (!props[r.name]) {
      if (r.type === "date") update.properties[r.name] = { date: {} };
      if (r.type === "select") update.properties[r.name] = { select: { options: (r.options || []).map((n) => ({ name: n })) } };
      if (r.type === "url") update.properties[r.name] = { url: {} };
      if (r.type === "rich_text") update.properties[r.name] = { rich_text: {} };
    } else if (r.type === "select") {
      // merge options if missing
      const existing = (props[r.name].select?.options || []).map((o) => o.name);
      const toAdd = (r.options || []).filter((n) => !existing.includes(n));
      if (toAdd.length) {
        update.properties[r.name] = { select: { options: [...existing.map((n) => ({ name: n })), ...toAdd.map((n) => ({ name: n }))] } };
      }
    }
  }
  if (Object.keys(update.properties).length) {
    await notion.databases.update({ database_id: NOTION_DATABASE_ID, ...update });
  }
}

// Build human-readable Notion blocks from analysis JSON string
function buildNotionBlocksFromAnalysis(analysisJsonStr) {
  const rich = (text) => [{ type: "text", text: { content: String(text) } }];
  const richLink = (text, url) => [{ type: "text", text: { content: String(text), link: url ? { url } : null } }];
  const heading = (text, level = 2) => ({ object: "block", type: `heading_${level}`, [`heading_${level}`]: { rich_text: rich(text) } });
  const para = (text) => ({ object: "block", type: "paragraph", paragraph: { rich_text: rich(text) } });
  const paraLink = (text, url) => ({ object: "block", type: "paragraph", paragraph: { rich_text: richLink(text, url) } });
  const bullet = (text, children) => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rich(text), children } });
  const numbered = (text, children) => ({ object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: rich(text), children } });
  const callout = (text) => ({ object: "block", type: "callout", callout: { icon: { type: 'emoji', emoji: '📝' }, rich_text: rich(String(text).slice(0, 2000)) } });

  let data;
  try {
    data = JSON.parse(analysisJsonStr);
  } catch {
    try {
      let cleaned = analysisJsonStr.replace(/^```[a-zA-Z]*[\s\r\n]+/i, "").replace(/```\s*$/i, "").trim();
      const first = cleaned.indexOf("{");
      const last = cleaned.lastIndexOf("}");
      if (first !== -1 && last !== -1) cleaned = cleaned.slice(first, last + 1);
      cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
      data = JSON.parse(cleaned);
    } catch {
      return [heading("Анализ"), para("Не удалось преобразовать результат в структуру. См. исходный JSON ниже."), { object: "block", type: "code", code: { language: "json", rich_text: rich(analysisJsonStr.slice(0, 1900)) } }];
    }
  }

  const map = {};
  Object.entries(data).forEach(([k, v]) => {
    const norm = String(k).toLowerCase().replace(/\s+/g, "_");
    map[norm] = v;
  });

  const blocks = [];

  // Summary callout
  const pickText = (arr) => Array.isArray(arr) ? arr.slice(0, 4).map((t) => (t && typeof t === 'object') ? (t.описание || '') : String(t)).filter(Boolean).join('; ') : '';
  const summaryText = [
    pickText(map["технические_требования"]),
    pickText(map["функциональные_требования"]),
    pickText(map["нефункциональные_требования"]),
    pickText(map["инфраструктурные_требования"])
  ].filter(Boolean).join('; ');
  blocks.push(callout(summaryText ? `Ключевые требования: ${summaryText}` : 'Ключевые требования: —'));

  // Описание документа
  blocks.push(heading("Описание документа", 2));
  const descr = map["описание_документа"];
  blocks.push(para(descr ? (typeof descr === "string" ? descr : JSON.stringify(descr)) : "—"));

  // Ссылка на оригинальное ТЗ
  blocks.push(heading("Ссылка на оригинальное ТЗ", 2));
  const tzUrl = typeof map["ссылка_на_оригинальное_тз"] === "string" ? map["ссылка_на_оригинальное_тз"] : null;
  blocks.push(tzUrl ? paraLink(tzUrl, tzUrl) : para("—"));

  // Контактные лица
  blocks.push(heading("Контактные лица", 2));
  const contacts = map["контактные_лица"];
  if (Array.isArray(contacts) && contacts.length) {
    contacts.forEach((c) => {
      if (c && typeof c === "object") {
        const line = [c.фио, c.роль, c.email, c.телефон].filter(Boolean).join(" — ");
        blocks.push(bullet(line || JSON.stringify(c)));
      } else blocks.push(bullet(String(c)));
    });
  } else {
    blocks.push(para("—"));
  }


  // Технические требования
  blocks.push(heading("1.1. Требования", 2));
  const tech = map["технические_требования"];
  if (Array.isArray(tech) && tech.length) {
    tech.forEach((t) => {
      if (t && typeof t === "object") {
        const line = t.описание || JSON.stringify(t);
        const children = t.цитата ? [para(`«${t.цитата}»`)] : undefined;
        blocks.push(bullet(line, children));
      } else blocks.push(bullet(String(t)));
    });
  } else {
    blocks.push(para("—"));
  }

  // Ограничения и риски
  blocks.push(heading("1.2. Ограничения", 2));
  const limits = map["ограничения_и_риски"] ?? map["ограничения"];
  if (Array.isArray(limits) && limits.length) {
    limits.forEach((t) => {
      if (t && typeof t === "object") {
        const line = t.описание || JSON.stringify(t);
        const children = t.цитата ? [para(`«${t.цитата}»`)] : undefined;
        blocks.push(bullet(line, children));
      } else blocks.push(bullet(String(t)));
    });
  } else {
    blocks.push(para("—"));
  }

  // Функциональные / Нефункциональные / Инфраструктурные
  const sections = [
    ["Функциональные требования", map["функциональные_требования"]],
    ["Нефункциональные требования", map["нефункциональные_требования"]],
    ["Инфраструктурные требования", map["инфраструктурные_требования"]],
  ];
  sections.forEach(([title, arr]) => {
    blocks.push(heading(title, 2));
    if (Array.isArray(arr) && arr.length) {
      arr.forEach((t) => {
        if (t && typeof t === "object") {
          const line = t.описание || JSON.stringify(t);
          const children = t.цитата ? [para(`«${t.цитата}»`)] : undefined;
          blocks.push(bullet(line, children));
        } else blocks.push(bullet(String(t)));
      });
    } else {
      blocks.push(para("—"));
    }
  });

  // Сроки и стоимость
  blocks.push(heading("Сроки реализации и стоимость проекта", 2));
  const cost = map["сроки_реализации_и_стоимость_проекта"];
  if (cost) {
    if (Array.isArray(cost)) cost.forEach((t) => blocks.push(bullet(t)));
    else blocks.push(para(cost));
  } else {
    blocks.push(para("—"));
  }

  // Необходимые документы и поля
  blocks.push(heading("Типы документов на обработку", 2));
  const docs = map["необходимые_документы_и_поля"];
  if (Array.isArray(docs) && docs.length) {
    docs.forEach((d) => {
      if (d && typeof d === "object") {
        const title = d.документ || d.название || d.name || "Документ";
        const fields = Array.isArray(d.поля || d.fields) ? (d.поля || d.fields) : [];
        const children = fields.map((f) => bullet(typeof f === "string" ? f : JSON.stringify(f)));
        blocks.push(numbered(title, children.length ? children : undefined));
      } else blocks.push(numbered(String(d)));
    });
  } else {
    blocks.push(para("—"));
  }

  // Требуемые доработки
  blocks.push(heading("Требуемые доработки", 2));
  const upgrades = map["требуемые_доработки"];
  if (Array.isArray(upgrades) && upgrades.length) {
    upgrades.forEach((u) => {
      if (u && typeof u === "object") {
        const main = [u.описание, u.приоритет, u.оценка_сложности].filter(Boolean).join(" — ");
        const children = u.цитата ? [para(`«${u.цитата}»`)] : undefined;
        blocks.push(bullet(main || JSON.stringify(u), children));
      } else blocks.push(bullet(String(u)));
    });
  } else {
    blocks.push(para("—"));
  }

  // Сопоставление с Dbrain
  blocks.push(heading("Сопоставление с Dbrain", 2));
  const mapping = map["сопоставление_с_dbrain"];
  if (Array.isArray(mapping) && mapping.length) {
    mapping.forEach((m) => {
      if (m && typeof m === "object") {
        const main = [m.требование, m.статус, m.комментарий].filter(Boolean).join(" — ");
        const children = m.цитата ? [para(`«${m.цитата}»`)] : undefined;
        blocks.push(bullet(main || JSON.stringify(m), children));
      } else blocks.push(bullet(String(m)));
    });
  } else {
    blocks.push(para("—"));
  }

  return blocks;
}

// Normalize/repair a possibly non-strict JSON string into strict JSON for storage
function normalizeJsonString(possible) {
  try {
    const obj = JSON.parse(possible);
    return JSON.stringify(obj);
  } catch {
    try {
      let cleaned = String(possible).replace(/^```[a-zA-Z]*[\s\r\n]+/i, "").replace(/```\s*$/i, "").trim();
      const first = cleaned.indexOf("{");
      const last = cleaned.lastIndexOf("}");
      if (first !== -1 && last !== -1) cleaned = cleaned.slice(first, last + 1);
      cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
      const obj = JSON.parse(cleaned);
      return JSON.stringify(obj);
    } catch {
      return String(possible);
    }
  }
}

const app = express();
app.use(express.json());
app.use(express.static("public"));

// Storage directory (temp files) – ensure exists
const UPLOAD_DIR = "/tmp/uploads";
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Configure Multer limits: unlimited if MAX_FILE_SIZE_BYTES <= 0
const multerLimits = {};
if (Number(MAX_FILE_SIZE_BYTES) > 0) {
  multerLimits.fileSize = Number(MAX_FILE_SIZE_BYTES);
}

const upload = multer({
  dest: UPLOAD_DIR,
  limits: multerLimits,
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/octet-stream", // Safari/unknown
    ];
    if (!allowed.includes(file.mimetype)) return cb(new Error("Only PDF and DOCX files are allowed"));
    // If MIME is generic, validate by filename extension
    if (file.mimetype === "application/octet-stream") {
      const name = (file.originalname || "").toLowerCase();
      if (!name.endsWith(".pdf") && !name.endsWith(".docx")) {
        return cb(new Error("Only PDF and DOCX files are allowed"));
      }
    }
    cb(null, true);
  },
});

// Health / status endpoint
app.get("/api/status", (req, res) => {
  res.json({
    server: "running",
    openai: OPENAI_API_KEY ? "connected" : "disconnected",
    notion: NOTION_TOKEN && NOTION_DATABASE_ID ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
    version: {
      commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
      url: process.env.VERCEL_URL || null,
    }
  });
});

// Upload endpoint (prefixed with /api for Vercel routing)
app.post("/api/upload", upload.single("document"), async (req, res) => {
  try {
    const { path: filePath, mimetype, originalname } = req.file;
    // Fix filename mojibake (incoming latin1 -> utf8)
    let properName = Buffer.from(originalname, "latin1").toString("utf8");
    
    // Upload original to Blob (optional)
    const originalUrl = await uploadToBlob(filePath, properName, mimetype);

    let analysisJsonStr;
    let filename;
    let usedVectorStoreId = OPENAI_VECTOR_STORE;
    let retrievalFilesSummary = null;

    if (OPENAI_VECTOR_STORE) {
      // Retrieval-first: upload file to Vector Store and wait for indexing
      const { vectorStoreId, filesSummary } = await uploadFileToVS(filePath, properName, mimetype, OPENAI_VECTOR_STORE);
      usedVectorStoreId = vectorStoreId;
      retrievalFilesSummary = filesSummary || null;
      console.info(JSON.stringify({ event: 'analysis_path', mode: 'retrieval', assistant: !!OPENAI_ASSISTANT_ID, vectorStoreId, filename: properName, mimetype }));
      if (filesSummary) console.info(JSON.stringify({ event: 'vector_store_files', vectorStoreId, ...filesSummary }));
      analysisJsonStr = await analyzeDocument("", properName);
    } else {
      // Classic path: extract full text and analyze directly
      console.info(JSON.stringify({ event: 'analysis_path', mode: 'classic', filename: properName, mimetype }));
      const text = await extractText(filePath, mimetype);
      analysisJsonStr = await analyzeDocument(text, properName);
    }

    // Prepare parsed map
    let parsed = {};
    try { parsed = JSON.parse(analysisJsonStr); } catch {}
    const norm = {}; Object.entries(parsed || {}).forEach(([k, v]) => { norm[String(k).toLowerCase().replace(/\s+/g, "_")] = v; });

    // If Blob URL is available, inject it when link field is empty/missing
    if (originalUrl) {
      const linkSnake = typeof norm['ссылка_на_оригинальное_тз'] === 'string' ? norm['ссылка_на_оригинальное_тз'] : '';
      if (!linkSnake) { norm['ссылка_на_оригинальное_тз'] = originalUrl; analysisJsonStr = JSON.stringify({ ...parsed, 'ссылка_на_оригинальное_тз': originalUrl }); }
    }

    // Normalize JSON for storage stability
    analysisJsonStr = normalizeJsonString(analysisJsonStr);

    // Save locally
    filename = saveAnalysis(analysisJsonStr, originalname);

    // Respond
    res.json({ success: true, filename, notionPageId: null, analysis: analysisJsonStr, retrieval: { vectorStore: usedVectorStoreId, assistant: OPENAI_ASSISTANT_ID ? true : false }, retrievalFiles: retrievalFilesSummary, notion: { queued: !!(NOTION_TOKEN && NOTION_DATABASE_ID) }, upload: { blob: !!originalUrl, url: originalUrl } });

    // Background Notion export
    if (NOTION_TOKEN && NOTION_DATABASE_ID) {
      (async () => {
        try {
          const statusFile = `${STATUS_DIR}/${filename}.json`;
          fs.writeFileSync(statusFile, JSON.stringify({ status: "processing" }));
          const notion = new NotionClient({ auth: NOTION_TOKEN });
          await ensureNotionSchema(notion);

          // Parse again for properties
          let parsed = {}; try { parsed = JSON.parse(analysisJsonStr); } catch {}
          const norm = {}; Object.entries(parsed || {}).forEach(([k, v]) => { norm[String(k).toLowerCase().replace(/\s+/g, "_")] = v; });

          // Title = заказчик
          let titleText = '';
          const customer = norm['наименование_компании_заказчика'] ?? norm['заказчик'];
          if (Array.isArray(customer)) titleText = customer.filter(Boolean)[0] || '';
          else if (typeof customer === 'string') titleText = customer;
          titleText = normalizeCompanyName(titleText || properName);

          const descrProp = typeof norm["описание_документа"] === "string" ? norm["описание_документа"] : "";
          const linkProp0 = typeof norm["ссылка_на_оригинальное_тз"] === "string" ? norm["ссылка_на_оригинальное_тз"] : "";
          const finalLink = linkProp0 || originalUrl || "";

          const pageProps = {
            Name: { title: [{ text: { content: titleText.slice(0, 200) } }] },
            "Дата загрузки": { date: { start: new Date().toISOString() } },
            "Тип документа": { select: { name: mimetype.includes("pdf") ? "PDF" : "DOCX" } },
            Статус: { select: { name: "Новый" } },
          };
          if (descrProp) pageProps["Описание"] = { rich_text: [{ text: { content: String(descrProp).slice(0, 1900) } }] };
          if (finalLink) pageProps["Ссылка на ТЗ"] = { url: finalLink };

          // Build content blocks with summary at top
          const blocks = buildNotionBlocksFromAnalysis(analysisJsonStr);

          // Create page with first portion of blocks (avoid 100-block limit)
          const first = blocks.slice(0, 50);
          const rest = blocks.slice(50);
          const page = await notion.pages.create({ parent: { database_id: NOTION_DATABASE_ID }, properties: pageProps, children: first });

          // Append remaining blocks in batches of 90
          for (let i = 0; i < rest.length; i += 90) {
            const slice = rest.slice(i, i + 90);
            try { await notion.blocks.children.append({ block_id: page.id, children: slice }); } catch (e) { console.warn('notion_append_failed', e?.message); }
          }

          // Attach original file if present
          if (originalUrl) {
            try {
              await notion.blocks.children.append({ block_id: page.id, children: [ { object: 'block', type: 'file', file: { type: 'external', external: { url: originalUrl } } } ] });
            } catch {}
          }

          try { await notion.pages.update({ page_id: page.id, properties: { Статус: { select: { name: "Готово" } } } }); } catch {}
          const pageUrl = `https://www.notion.so/${String(page.id).replace(/-/g,'')}`;
          fs.writeFileSync(statusFile, JSON.stringify({ status: "success", pageId: page.id, pageUrl }));
        } catch (notionErr) {
          console.error("Notion export error", notionErr);
          const statusFile = `${STATUS_DIR}/${filename}.json`;
          fs.writeFileSync(statusFile, JSON.stringify({ status: "error", message: notionErr.message }));
        }
      })();
    }

    if (req.file?.path) { fs.unlink(req.file.path, () => {}); }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// History list endpoint
app.get("/api/analyses", async (req, res) => {
  try {
    const out = [];
    // Notion-backed history (latest first)
    if (NOTION_TOKEN && NOTION_DATABASE_ID) {
      try {
        const notion = new NotionClient({ auth: NOTION_TOKEN });
        const result = await notion.databases.query({
          database_id: NOTION_DATABASE_ID,
          page_size: 20,
          sorts: [{ timestamp: "created_time", direction: "descending" }],
        });
        (result.results || []).forEach((p) => {
          const title = (p.properties?.Name?.title || []).map((t) => t?.plain_text || "").join("") || "Untitled";
          const pageId = p.id;
          const pageUrl = `https://www.notion.so/${String(pageId).replace(/-/g,'')}`;
          out.push({ source: 'notion', pageId, pageUrl, title, created_time: p.created_time });
        });
      } catch (e) {
        // ignore notion errors, still return local files below
      }
    }
    // Local files history (fallback)
    const dir = path.join("/tmp", "analysis_results");
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      files.sort((a,b)=>{
        const getTs = (name)=>{ const m=name.match(/_(\d+)\.json$/); return m?Number(m[1]):0; };
        return getTs(b)-getTs(a);
      });
      files.forEach((f)=> out.push({ source: 'local', filename: f }));
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Specific analysis endpoint
app.get("/api/analyses/:file", (req, res) => {
  const filePath = path.join("/tmp", "analysis_results", req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
  const data = fs.readFileSync(filePath, "utf-8");
  res.type("application/json").send(data);
});

// Endpoint to poll Notion export status
app.get("/api/notion-status/:file", async (req, res) => {
  const file = req.params.file;
  const statusPath = `${STATUS_DIR}/${file}.json`;
  // 1) Try tmp status if exists
  if (fs.existsSync(statusPath)) {
    try {
      const data = fs.readFileSync(statusPath, "utf-8");
      return res.type("application/json").send(data);
    } catch (e) {
      // fall through
    }
  }
  // 2) Fallback to querying Notion DB by page title (Name contains base filename)
  if (NOTION_TOKEN && NOTION_DATABASE_ID) {
    try {
      const notion = new NotionClient({ auth: NOTION_TOKEN });
      const base = file.replace(/\.json$/i, "").replace(/_\d+$/, "");
      const result = await notion.databases.query({
        database_id: NOTION_DATABASE_ID,
        filter: { property: "Name", title: { contains: base } },
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: 1,
      });
      if (result.results && result.results.length > 0) {
        const pageId = result.results[0].id;
        const pageUrl = `https://www.notion.so/${String(pageId).replace(/-/g,'')}`;
        return res.json({ status: "success", pageId, pageUrl });
      }
    } catch (e) {
      return res.json({ status: "error", message: e.message });
    }
  }
  return res.json({ status: "unknown" });
});

// Endpoint to trigger schema ensure manually
app.post("/api/diag/notion-fix", async (req, res) => {
  try {
    if (!NOTION_TOKEN || !NOTION_DATABASE_ID) return res.status(400).json({ ok: false, message: "NOTION envs missing" });
    const notion = new NotionClient({ auth: NOTION_TOKEN });
    await ensureNotionSchema(notion);
    const db = await notion.databases.retrieve({ database_id: NOTION_DATABASE_ID });
    res.json({ ok: true, properties: Object.keys(db.properties) });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.get("/api/notion-fix-names", async (req, res) => {
  try {
    if (!NOTION_TOKEN || !NOTION_DATABASE_ID) return res.status(400).json({ error: "Notion is not configured" });
    const notion = new NotionClient({ auth: NOTION_TOKEN });
    const isMojibake = (s) => /[ÃÂÐÑ]/.test(s);
    const decodeLatin1ToUtf8 = (s) => Buffer.from(Buffer.from(String(s), "binary").toString("latin1"), "latin1").toString("utf8");

    const pages = await notion.databases.query({ database_id: NOTION_DATABASE_ID, page_size: 50 });
    const results = pages.results || [];
    const updates = [];
    for (const p of results) {
      const titleProp = p.properties?.Name?.title || [];
      const current = titleProp.map(t => t?.plain_text || "").join("");
      if (current && isMojibake(current)) {
        const fixed = decodeLatin1ToUtf8(current);
        try {
          await notion.pages.update({ page_id: p.id, properties: { Name: { title: [{ text: { content: fixed } }] } } });
          updates.push({ id: p.id, from: current, to: fixed });
        } catch (e) {
          updates.push({ id: p.id, error: e.message });
        }
      }
    }
    res.json({ success: true, updated: updates.length, updates });
  } catch (err) {
    console.error("notion-fix-names error", err);
    res.status(500).json({ error: err.message });
  }
});

// Diagnostics: check Notion token and database visibility
app.get("/api/diag/notion", async (req, res) => {
  try {
    if (!NOTION_TOKEN) return res.status(400).json({ ok: false, message: "NOTION_TOKEN is missing" });
    if (!NOTION_DATABASE_ID) return res.status(400).json({ ok: false, message: "NOTION_DATABASE_ID is missing" });
    const notion = new NotionClient({ auth: NOTION_TOKEN });
    try {
      const db = await notion.databases.retrieve({ database_id: NOTION_DATABASE_ID });
      return res.json({ ok: true, database: { id: db.id, title: db.title?.[0]?.plain_text || null } });
    } catch (e) {
      // If specific DB not accessible, list a few visible DBs to help diagnose workspace/permissions
      let visible = [];
      try {
        const found = await notion.search({
          filter: { value: "database", property: "object" },
          page_size: 5,
        });
        visible = (found.results || []).map((r) => ({ id: r.id, title: r.title?.[0]?.plain_text || null }));
      } catch {}
      return res.status(502).json({
        ok: false,
        code: e.code,
        status: e.status,
        message: e.message,
        databaseId: NOTION_DATABASE_ID,
        tokenPrefix: NOTION_TOKEN.slice(0, 7),
        visibleDatabases: visible,
      });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// Endpoint to trigger schema ensure manually
app.post("/api/diag/notion-fix", async (req, res) => {
  try {
    if (!NOTION_TOKEN || !NOTION_DATABASE_ID) return res.status(400).json({ ok: false, message: "NOTION envs missing" });
    const notion = new NotionClient({ auth: NOTION_TOKEN });
    await ensureNotionSchema(notion);
    const db = await notion.databases.retrieve({ database_id: NOTION_DATABASE_ID });
    res.json({ ok: true, properties: Object.keys(db.properties) });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.use((err, req, res, next) => {
  console.error('request_error', err);
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    const lim = Number(MAX_FILE_SIZE_BYTES);
    const mb = lim > 0 ? Math.round(lim / 1024 / 1024) : 0;
    const msg = lim > 0 ? `Файл слишком большой (макс. ${mb} МБ)` : 'Файл слишком большой';
    return res.status(413).json({ error: msg });
  }
  if (err && /Only PDF and DOCX files are allowed/i.test(err.message || '')) {
    return res.status(400).json({ error: 'Разрешены только файлы PDF и DOCX' });
  }
  res.status(500).json({ error: err?.message || 'Internal Server Error' });
});

export default app;

// For local dev
if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}