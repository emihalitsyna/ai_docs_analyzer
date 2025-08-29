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
    const allowed = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only PDF and DOCX files are allowed"));
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
    
    const text = await extractText(filePath, mimetype);
    const analysisJsonStr = await analyzeDocument(text, properName);

    // Save locally
    const filename = saveAnalysis(analysisJsonStr, originalname);

    // Send response to client immediately
    res.json({
      success: true,
      filename,
      notionPageId: null, // set after export
      analysis: analysisJsonStr,
      retrieval: { vectorStore: OPENAI_VECTOR_STORE, assistant: OPENAI_ASSISTANT_ID ? true : false },
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
          const chunkString = (s, size = 1900) => {
            const out = [];
            for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
            return out;
          };
          const chunks = chunkString(analysisJsonStr, 1900);
          const page = await notion.pages.create({
            parent: { database_id: NOTION_DATABASE_ID },
            properties: {
              Name: { title: [{ text: { content: originalname } }] },
              "Дата загрузки": { date: { start: new Date().toISOString() } },
              "Тип документа": { select: { name: mimetype.includes("pdf") ? "PDF" : "DOCX" } },
              Статус: { select: { name: "Новый" } },
            },
            children: chunks.map((c) => ({
              object: "block",
              type: "code",
              code: { language: "json", rich_text: [{ type: "text", text: { content: c } }] },
            })),
          });
          fs.writeFileSync(statusFile, JSON.stringify({ status: "success", pageId: page.id }));
        } catch (notionErr) {
          console.error("Notion export error", notionErr);
          const statusFile = `${STATUS_DIR}/${filename}.json`;
          fs.writeFileSync(statusFile, JSON.stringify({ status: "error", message: notionErr.message }));
        }
      })();
    }

    // 2) Upload original file to Vector Store and then cleanup temp file
    if (req.file?.path) {
      uploadFileToVS(req.file.path, req.file.originalname)
        .catch(() => {})
        .finally(() => fs.unlink(req.file.path, () => {}));
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

export default app;

// For local dev
if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}