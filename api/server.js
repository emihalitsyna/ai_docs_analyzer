// api/server.js
import express from "express";
import serverlessExpress from "@codegenie/serverless-express";
import multer from "multer";
import fs from "fs";
import path from "path";
import {
  OPENAI_API_KEY,
  NOTION_TOKEN,
  NOTION_DATABASE_ID,
  MAX_FILE_SIZE_BYTES,
} from "../config.js";
import extractText from "./extractText.js";
import analyzeDocument, { saveAnalysis } from "./analysis.js";
import { Client as NotionClient } from "@notionhq/client";

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
    const text = await extractText(filePath, mimetype);
    const analysisJsonStr = await analyzeDocument(text, originalname);

    // Save locally
    const filename = saveAnalysis(analysisJsonStr, originalname);

    // Optional Notion export
    let notionPageId = null;
    if (NOTION_TOKEN && NOTION_DATABASE_ID) {
      try {
        const notion = new NotionClient({ auth: NOTION_TOKEN });
        const page = await notion.pages.create({
          parent: { database_id: NOTION_DATABASE_ID },
          properties: {
            Name: { title: [{ text: { content: originalname } }] },
            "Дата загрузки": { date: { start: new Date().toISOString() } },
            "Тип документа": { select: { name: mimetype.includes("pdf") ? "PDF" : "DOCX" } },
            Статус: { select: { name: "Новый" } },
          },
          children: [
            {
              object: "block",
              type: "code",
              code: {
                language: "json",
                rich_text: [{ type: "text", text: { content: analysisJsonStr } }],
              },
            },
          ],
        });
        notionPageId = page.id;
      } catch (notionErr) {
        console.error("Notion export error", notionErr);
      }
    }

    res.json({ success: true, filename, notionPageId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
  }
});

// History list endpoint
app.get("/api/analyses", (req, res) => {
  const dir = path.join(path.resolve(), "backend/analysis_results");
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  res.json(files);
});

// Specific analysis endpoint
app.get("/api/analyses/:file", (req, res) => {
  const filePath = path.join(path.resolve(), "backend/analysis_results", req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
  const data = fs.readFileSync(filePath, "utf-8");
  res.type("application/json").send(data);
});

export const handler = serverlessExpress({ app });
export default handler;

// For local dev
if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
} 