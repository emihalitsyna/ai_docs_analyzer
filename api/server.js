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
const STATUS_DIR = "/tmp/notion_status";
if (!fs.existsSync(STATUS_DIR)) fs.mkdirSync(STATUS_DIR, { recursive: true });

// Ensure Notion database has required properties
async function ensureNotionSchema(notion) {
  // Fetch DB
  const db = await notion.databases.retrieve({ database_id: NOTION_DATABASE_ID });
  const props = db.properties || {};
  const required = [
    { name: "Дата загрузки", type: "date" },
    { name: "Тип документа", type: "select", options: ["PDF", "DOCX"] },
    { name: "Статус", type: "select", options: ["Новый", "Готово", "Ошибка"] },
  ];
  const update = { properties: {} };
  for (const r of required) {
    if (!props[r.name]) {
      if (r.type === "date") update.properties[r.name] = { date: {} };
      if (r.type === "select") update.properties[r.name] = { select: { options: (r.options || []).map((n) => ({ name: n })) } };
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
  const heading = (text, level = 2) => ({ object: "block", type: `heading_${level}`, [`heading_${level}`]: { rich_text: rich(text) } });
  const para = (text) => ({ object: "block", type: "paragraph", paragraph: { rich_text: rich(text) } });
  const bullet = (text, children) => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rich(text), children } });
  const numbered = (text, children) => ({ object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: rich(text), children } });

  let data;
  try {
    data = JSON.parse(analysisJsonStr);
  } catch {
    // Fallback: try to strip code fences and parse first {...}
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

  // Normalize keys -> lower_snake
  const map = {};
  Object.entries(data).forEach(([k, v]) => {
    const norm = String(k).toLowerCase().replace(/\s+/g, "_");
    map[norm] = v;
  });

  const blocks = [];

  // Заказчик
  const customer = map["наименование_компании_заказчика"] ?? map["заказчик"];
  if (customer) {
    blocks.push(heading("Наименование заказчика", 2));
    if (Array.isArray(customer)) customer.forEach((it) => blocks.push(bullet(it)));
    else blocks.push(para(customer));
  }

  // Технические требования
  const tech = map["технические_требования"];
  if (tech && Array.isArray(tech) && tech.length) {
    blocks.push(heading("1.1. Требования", 2));
    tech.forEach((t) => blocks.push(bullet(t)));
  }

  // Ограничения и риски
  const limits = map["ограничения_и_риски"] ?? map["ограничения"];
  if (limits && Array.isArray(limits) && limits.length) {
    blocks.push(heading("1.2. Ограничения", 2));
    limits.forEach((t) => blocks.push(bullet(t)));
  }

  // Функциональные / Нефункциональные / Инфраструктурные
  const sections = [
    ["Функциональные требования", map["функциональные_требования"]],
    ["Нефункциональные требования", map["нефункциональные_требования"]],
    ["Инфраструктурные требования", map["инфраструктурные_требования"]],
  ];
  sections.forEach(([title, arr]) => {
    if (arr && Array.isArray(arr) && arr.length) {
      blocks.push(heading(title, 2));
      arr.forEach((t) => blocks.push(bullet(t)));
    }
  });

  // Сроки и стоимость
  const cost = map["сроки_реализации_и_стоимость_проекта"];
  if (cost) {
    blocks.push(heading("Сроки реализации и стоимость проекта", 2));
    if (Array.isArray(cost)) cost.forEach((t) => blocks.push(bullet(t)));
    else blocks.push(para(cost));
  }

  // Необходимые документы и поля
  const docs = map["необходимые_документы_и_поля"];
  if (docs && Array.isArray(docs) && docs.length) {
    blocks.push(heading("Типы документов на обработку", 2));
    docs.forEach((d) => {
      if (d && typeof d === "object") {
        const title = d.документ || d.название || d.name || "Документ";
        const fields = Array.isArray(d.поля || d.fields) ? (d.поля || d.fields) : [];
        const children = fields.map((f) => bullet(typeof f === "string" ? f : JSON.stringify(f)));
        blocks.push(numbered(title, children.length ? children : undefined));
      } else {
        blocks.push(numbered(String(d)));
      }
    });
  }

  if (!blocks.length) {
    // Fallback to code block if nothing produced
    return [{ object: "block", type: "code", code: { language: "json", rich_text: rich(analysisJsonStr.slice(0, 1900)) } }];
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

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
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
  });
});

// Upload endpoint (prefixed with /api for Vercel routing)
app.post("/api/upload", upload.single("document"), async (req, res) => {
  try {
    const { path: filePath, mimetype, originalname } = req.file;
    // Fix filename mojibake (incoming latin1 -> utf8)
    let properName = Buffer.from(originalname, "latin1").toString("utf8");
    
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

    // Normalize JSON for storage stability
    analysisJsonStr = normalizeJsonString(analysisJsonStr);

    // Save locally
    filename = saveAnalysis(analysisJsonStr, originalname);

    // Send response to client immediately
    res.json({
      success: true,
      filename,
      notionPageId: null, // set after export
      analysis: analysisJsonStr,
      retrieval: { vectorStore: usedVectorStoreId, assistant: OPENAI_ASSISTANT_ID ? true : false },
      retrievalFiles: retrievalFilesSummary,
      notion: { queued: !!(NOTION_TOKEN && NOTION_DATABASE_ID) }
    });

    // ---- Background side-effects (fire-and-forget) ----
    // 1) Notion export (chunked to avoid 2k limit per block)
    if (NOTION_TOKEN && NOTION_DATABASE_ID) {
      (async () => {
        try {
          const statusFile = `${STATUS_DIR}/${filename}.json`;
          fs.writeFileSync(statusFile, JSON.stringify({ status: "processing" }));
          const notion = new NotionClient({ auth: NOTION_TOKEN });
          await ensureNotionSchema(notion);
          const chunkString = (s, size = 1900) => {
            const out = [];
            for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
            return out;
          };
          const blocks = buildNotionBlocksFromAnalysis(analysisJsonStr);
          const page = await notion.pages.create({
            parent: { database_id: NOTION_DATABASE_ID },
            properties: {
              Name: { title: [{ text: { content: properName } }] },
              "Дата загрузки": { date: { start: new Date().toISOString() } },
              "Тип документа": { select: { name: mimetype.includes("pdf") ? "PDF" : "DOCX" } },
              Статус: { select: { name: "Новый" } },
            },
            children: blocks,
          });
          // Mark as done
          try {
            await notion.pages.update({ page_id: page.id, properties: { Статус: { select: { name: "Готово" } } } });
          } catch {}
          fs.writeFileSync(statusFile, JSON.stringify({ status: "success", pageId: page.id }));
        } catch (notionErr) {
          console.error("Notion export error", notionErr);
          const statusFile = `${STATUS_DIR}/${filename}.json`;
          fs.writeFileSync(statusFile, JSON.stringify({ status: "error", message: notionErr.message }));
        }
      })();
    }

    // 2) Cleanup temp upload file
    if (req.file?.path) {
      fs.unlink(req.file.path, () => {});
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// History list endpoint
app.get("/api/analyses", (req, res) => {
  const dir = path.join("/tmp", "analysis_results");
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  res.json(files);
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
        return res.json({ status: "success", pageId });
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
    return res.status(413).json({ error: 'Файл слишком большой (макс. 10 МБ)' });
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