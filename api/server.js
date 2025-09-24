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
import analyzeDocument, { analyzeDocumentFull, saveAnalysis, buildPromptWithKB, SYSTEM_PROMPT } from "./analysis.js";
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
    { name: "Тип документа", type: "select", options: ["PDF", "DOCX", "CSV", "TXT"] },
    { name: "Статус", type: "select", options: ["Новый", "Готово", "Ошибка"] },
    { name: "Описание", type: "rich_text" },
    { name: "Ссылки и файлы", type: "files" },
    { name: "Контакты", type: "rich_text" },
    { name: "Доработки", type: "rich_text" },
    { name: "Сопоставление с Dbrain", type: "rich_text" },
    { name: "FileKey", type: "rich_text" },
  ];
  const update = { properties: {} };
  for (const r of required) {
    if (!props[r.name]) {
      if (r.type === "date") update.properties[r.name] = { date: {} };
      if (r.type === "select") update.properties[r.name] = { select: { options: (r.options || []).map((n) => ({ name: n })) } };
      if (r.type === "url") update.properties[r.name] = { url: {} };
      if (r.type === "rich_text") update.properties[r.name] = { rich_text: {} };
      if (r.type === "files") update.properties[r.name] = { files: {} };
    } else if (r.type === "select") {
      // merge options if missing
      const existing = (props[r.name].select?.options || []).map((o) => o.name);
      const toAdd = (r.options || []).filter((n) => !existing.includes(n));
      if (toAdd.length) {
        update.properties[r.name] = { select: { options: [...existing.map((n) => ({ name: n })), ...toAdd.map((n) => ({ name: n }))] } };
      }
    }
  }
  try {
    if (Object.keys(update.properties).length) {
      await notion.databases.update({ database_id: NOTION_DATABASE_ID, ...update });
    }
  } catch (e) {
    // Ignore schema update errors, proceed with current props
  }
  // Return fresh properties map after attempted update
  try {
    const db2 = await notion.databases.retrieve({ database_id: NOTION_DATABASE_ID });
    return db2.properties || {};
  } catch {
    return props;
  }
}

// Attempt to parse plain-text analysis (sections 1–7) into normalized data map
function parseTextAnalysisToData(text){
  try{
    const lines=String(text).split(/\r?\n/);
    // Find section ranges by lines like "1. ..."
    const indices=[];
    for(let i=0;i<lines.length;i++){
      const m=lines[i].match(/^\s*([1-7])\.(\s+)(.+)$/);
      if(m){ indices.push({ idx:i, num:parseInt(m[1],10), title:m[3].trim() }); }
    }
    const getRange=(n)=>{
      const cur=indices.find(x=>x.num===n);
      if(!cur) return [];
      const pos=indices.indexOf(cur);
      const end= pos+1<indices.length ? indices[pos+1].idx : lines.length;
      return lines.slice(cur.idx+1, end);
    };

    const trimBullet=(s)=>String(s).replace(/^\s*[-–•*]\s*/,'').trim();
    const parseBullets=(arr)=>{
      const res=[]; let buffer=[];
      for(const ln of arr){
        if(/^\s*[-–•*]\s+/.test(ln)){ if(buffer.length){ const t=buffer.join(' ').trim(); if(t) res.push(t); buffer=[]; }
          res.push(trimBullet(ln));
        } else {
          const t=String(ln).trim();
          if(t) buffer.push(t);
        }
      }
      if(buffer.length){ const t=buffer.join(' ').trim(); if(t) res.push(t); }
      return res;
    };

    const data={};
    // 1. Описание проекта -> описание_документа
    const s1=getRange(1).join('\n').trim();
    if(s1) data['описание_документа']=s1;

    // 2. Типы документов на обработку -> необходимые_документы_и_поля (как список строк)
    const s2=parseBullets(getRange(2));
    if(s2.length) data['необходимые_документы_и_поля']=s2;

    // 3. Требования -> разложить по подзаголовкам с маркерами "- ... требования"
    const sec3=getRange(3);
    if(sec3.length){
      const subIdx=[];
      for(let i=0;i<sec3.length;i++){
        const m=sec3[i].match(/^\s*[-–•*]\s*(Технические требования|Функциональные требования|Нефункциональные требования|Инфраструктурные требования|Ограничения и риски)\s*$/i);
        if(m) subIdx.push({ i, t:m[1].toLowerCase() });
      }
      const get3Range=(label, start)=>{
        const pos=subIdx.findIndex(x=>x.i===start);
        const end= pos+1<subIdx.length ? subIdx[pos+1].i : sec3.length;
        return sec3.slice(start+1,end);
      };
      const mapKey=(t)=>{
        if(/технические/i.test(t)) return 'технические_требования';
        if(/функциональные/i.test(t)) return 'функциональные_требования';
        if(/нефункциональные/i.test(t)) return 'нефункциональные_требования';
        if(/инфраструктурные/i.test(t)) return 'инфраструктурные_требования';
        return 'ограничения_и_риски';
      };
      subIdx.forEach(s=>{
        const key=mapKey(s.t);
        const items=parseBullets(get3Range(s.t, s.i));
        if(items.length) data[key]=items.map(x=>({ описание:x }));
      });
    }

    // 4. Список необходимых доработок -> требуемые_доработки
    const s4=parseBullets(getRange(4));
    if(s4.length) data['требуемые_доработки']=s4.map(x=>({ описание:x }));

    // 5. Контактные лица и способы связи -> контакты
    const s5=getRange(5);
    const contactItems=parseBullets(s5);
    if(contactItems.length){ data['контактные_лица']=contactItems.map(x=>String(x)); }

    // 6. Ссылки и файлы -> ссылка_на_оригинальное_тз (первый URL) и список ссылок
    const s6=getRange(6).join('\n');
    const urls=Array.from(String(s6).matchAll(/https?:\/\/\S+/g)).map(m=>m[0]);
    if(urls.length){ data['ссылка_на_оригинальное_тз']=urls[0]; data['ссылки']=urls; }

    // 7. Оригинал ТЗ — не дублируем, ссылка добавится выше при наличии

    return Object.keys(data).length ? data : null;
  }catch{ return null; }
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

  let data;
  try { data = JSON.parse(analysisJsonStr); }
  catch {
    try {
      let cleaned = analysisJsonStr.replace(/^```[a-zA-Z]*[\s\r\n]+/i, "").replace(/```\s*$/i, "").trim();
      const first = cleaned.indexOf("{");
      const last = cleaned.lastIndexOf("}");
      if (first !== -1 && last !== -1) cleaned = cleaned.slice(first, last + 1);
      cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
      data = JSON.parse(cleaned);
    } catch {
      // Fallback: parse plain text with sections 1–7
      const parsed = parseTextAnalysisToData(analysisJsonStr);
      if(parsed){ data = parsed; }
      else {
        return [heading("Анализ"), para("Не удалось преобразовать результат в структуру."), { object: "block", type: "code", code: { language: "json", rich_text: rich(analysisJsonStr.slice(0, 1900)) } }];
      }
    }
  }

  const map = {}; Object.entries(data).forEach(([k,v])=>{ map[String(k).toLowerCase().replace(/\s+/g,'_')] = v; });
  const blocks = [];

  // Описание
  blocks.push(heading("Описание", 2));
  const descr = map['описание_документа'];
  blocks.push(para(descr ? (typeof descr==='string'?descr:JSON.stringify(descr)) : '—'));

  // Вложенный блок требований (как подзаголовки)
  const reqSections = [
    ['Технические требования', map['технические_требования']],
    ['Функциональные требования', map['функциональные_требования']],
    ['Нефункциональные требования', map['нефункциональные_требования']],
    ['Инфраструктурные требования', map['инфраструктурные_требования']],
    ['Ограничения и риски', map['ограничения_и_риски']],
  ];
  reqSections.forEach(([title, arr])=>{
    blocks.push(heading(title,3));
    if(Array.isArray(arr) && arr.length){
      arr.forEach((t)=>{
        if(t && typeof t==='object'){
          const line=t.описание||JSON.stringify(t);
          const children=t.цитата?[para(`«${t.цитата}»`)]:undefined;
          blocks.push(bullet(line, children));
        } else blocks.push(bullet(String(t)));
      });
    } else { blocks.push(para('—')); }
  });

  // Типы документов на обработку
  blocks.push(heading("Типы документов на обработку",2));
  const docs = map['необходимые_документы_и_поля'];
  if (Array.isArray(docs) && docs.length) {
    docs.forEach((d)=>{
      if (d && typeof d==='object'){
        const title=d.документ||d.название||d.name||'Документ';
        const fields=Array.isArray(d.поля||d.fields)?(d.поля||d.fields):[];
        const children=fields.map((f)=>bullet(typeof f==='string'?f:JSON.stringify(f)));
        blocks.push(numbered(title, children.length?children:undefined));
      } else blocks.push(numbered(String(d)));
    });
  } else { blocks.push(para('—')); }

  // Список необходимых доработок
  blocks.push(heading("Список необходимых доработок",2));
  const upgrades = map['требуемые_доработки'];
  if (Array.isArray(upgrades) && upgrades.length){
    upgrades.forEach((u)=>{
      if(u && typeof u==='object'){
        const main=[u.описание,u.приоритет,u.оценка_сложности].filter(Boolean).join(' — ');
        const children=u.цитата?[para(`«${u.цитата}»`)]:undefined;
        blocks.push(bullet(main||JSON.stringify(u),children));
      } else blocks.push(bullet(String(u)));
    });
  } else { blocks.push(para('—')); }

  // Контакты
  blocks.push(heading("Контактные лица, способ связи",2));
  const contacts = map['контактные_лица'];
  if(Array.isArray(contacts) && contacts.length){
    contacts.forEach((c)=>{
      if(c && typeof c==='object'){
        const line=[c.фио,c.роль,c.email,c.телефон].filter(Boolean).join(' — ');
        blocks.push(bullet(line||JSON.stringify(c)));
      } else blocks.push(bullet(String(c)));
    });
  } else { blocks.push(para('—')); }

  // Ссылки и файлы (в контенте URL; вложение кладём в свойства отдельно)
  blocks.push(heading("Ссылки и файлы",2));
  const tzUrl = typeof map['ссылка_на_оригинальное_тз']==='string'? map['ссылка_на_оригинальное_тз']:null;
  blocks.push(tzUrl ? paraLink(tzUrl, tzUrl) : para('—'));

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
    const fullTextFlag = (req.body && (req.body.fullText === '1' || req.body.fullText === 'true')) ? true : false;
    // Fix filename mojibake (incoming latin1 -> utf8)
    let properName = Buffer.from(originalname, "latin1").toString("utf8");
    
    // Upload original to Blob (optional)
    const originalUrl = await uploadToBlob(filePath, properName, mimetype);

    let usedVectorStoreId = OPENAI_VECTOR_STORE;
    let retrievalFilesSummary = null;

    // Pre-create analysis filename and placeholder
    const safeName = `${path.parse(originalname).name}_${Date.now()}.json`;
    const outDir = path.join("/tmp", "analysis_results");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, safeName);
    fs.writeFileSync(outPath, JSON.stringify({ status: "processing" }), "utf-8");

    // If Retrieval enabled, upload to Vector Store (diagnostic/optional)
    if (OPENAI_VECTOR_STORE) {
      try {
      const { vectorStoreId, filesSummary } = await uploadFileToVS(filePath, properName, mimetype, OPENAI_VECTOR_STORE);
      usedVectorStoreId = vectorStoreId;
      retrievalFilesSummary = filesSummary || null;
        console.info(JSON.stringify({ event: 'analysis_path', mode: 'retrieval+fulltext', assistant: !!OPENAI_ASSISTANT_ID, vectorStoreId, filename: properName, mimetype }));
      if (filesSummary) console.info(JSON.stringify({ event: 'vector_store_files', vectorStoreId, ...filesSummary }));
      } catch (e) {
        console.warn('vector_store_error', e?.message);
      }
    }

    // Respond immediately; start background analysis
    res.json({
      success: true,
      filename: safeName,
      notionPageId: null,
      analysis: null,
      retrieval: { vectorStore: usedVectorStoreId, assistant: OPENAI_ASSISTANT_ID ? true : false },
      retrievalFiles: retrievalFilesSummary,
      notion: { queued: !!(NOTION_TOKEN && NOTION_DATABASE_ID) },
      upload: { blob: !!originalUrl, url: originalUrl },
      mode: fullTextFlag ? 'full_text' : 'standard'
    });

    // ---- Background work ----
      (async () => {
      try {
        // 1) Extract full text and analyze (branch by mode)
        const text = await extractText(filePath, mimetype);
        let analysisJsonStr = fullTextFlag
          ? await analyzeDocumentFull(text, properName)
          : await analyzeDocument(text, properName);
        // Normalize
        analysisJsonStr = normalizeJsonString(analysisJsonStr);
        // If Blob URL is available, inject it when link field is empty/missing
        try {
          const obj = JSON.parse(analysisJsonStr);
          const linkSnake = typeof obj['ссылка_на_оригинальное_тз'] === 'string' ? obj['ссылка_на_оригинальное_тз'] : '';
          if (originalUrl && !linkSnake) obj['ссылка_на_оригинальное_тз'] = originalUrl;
          analysisJsonStr = JSON.stringify(obj);
        } catch {}
        // Save to the pre-created file
        fs.writeFileSync(outPath, analysisJsonStr, "utf-8");

        // Also persist analysis to durable storage (Vercel Blob) for serverless environments
        try {
          if (BLOB_READ_WRITE_TOKEN) {
            const { put } = await import('@vercel/blob');
            await put(`analyses/${safeName}`, analysisJsonStr, {
              access: 'public',
              token: BLOB_READ_WRITE_TOKEN,
              contentType: 'application/json; charset=utf-8'
            });
          }
        } catch (e) {
          console.warn('blob_upload_analysis_failed', e?.message || e);
        }

        // 2) Notion export
        if (NOTION_TOKEN && NOTION_DATABASE_ID) {
          try {
            const statusFile = `${STATUS_DIR}/${safeName}.json`;
          fs.writeFileSync(statusFile, JSON.stringify({ status: "processing" }));
          const notion = new NotionClient({ auth: NOTION_TOKEN });
          const dbProps = await ensureNotionSchema(notion);
          const hasFileKeyProp = !!dbProps?.['FileKey'];

            // Parse for properties
            let parsed = {}; try { parsed = JSON.parse(analysisJsonStr); } catch {}
            const norm = {}; Object.entries(parsed || {}).forEach(([k, v]) => { norm[String(k).toLowerCase().replace(/\s+/g, "_")] = v; });
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
              "Тип документа": { select: { name: mimetype.includes("pdf") ? "PDF" : (mimetype.includes("word")||mimetype.includes("officedocument"))?"DOCX":(mimetype.includes("csv")?"CSV":"TXT") } },
              Статус: { select: { name: "Новый" } },
            };
            if (hasFileKeyProp) pageProps["FileKey"] = { rich_text: [{ text: { content: safeName } }] };
            if (descrProp) pageProps["Описание"] = { rich_text: [{ text: { content: String(descrProp).slice(0, 1900) } }] };
            if (finalLink) pageProps["Ссылки и файлы"] = { files: [ { name: properName, external: { url: finalLink } } ] };

            const blocks = buildNotionBlocksFromAnalysis(analysisJsonStr);
            const first = blocks.slice(0, 50);
            const rest = blocks.slice(50);
            const page = await notion.pages.create({ parent: { database_id: NOTION_DATABASE_ID }, properties: pageProps, children: first });
            for (let i = 0; i < rest.length; i += 90) {
              const slice = rest.slice(i, i + 90);
              try { await notion.blocks.children.append({ block_id: page.id, children: slice }); } catch {}
            }
            if (originalUrl) {
              try { await notion.blocks.children.append({ block_id: page.id, children: [ { object: 'block', type: 'file', file: { type: 'external', external: { url: originalUrl } } } ] }); } catch {}
            }
            try { await notion.pages.update({ page_id: page.id, properties: { Статус: { select: { name: "Готово" } } } }); } catch {}
            const pageUrl = `https://www.notion.so/${String(page.id).replace(/-/g,'')}`;
            fs.writeFileSync(statusFile, JSON.stringify({ status: "success", pageId: page.id, pageUrl }));
        } catch (notionErr) {
            const statusFile = `${STATUS_DIR}/${safeName}.json`;
          fs.writeFileSync(statusFile, JSON.stringify({ status: "error", message: notionErr.message }));
          }
        }
      } catch (e) {
        // Write error into file
        try { fs.writeFileSync(outPath, JSON.stringify({ error: e.message }), "utf-8"); } catch {}
      } finally {
        // Cleanup temp upload file
        if (req.file?.path) { fs.unlink(req.file.path, () => {}); }
        }
      })();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Preview endpoint: returns the exact messages that would be sent to the model
app.post("/api/preview", upload.single("document"), async (req, res) => {
  try {
    const { path: filePath, mimetype, originalname } = req.file || {};
    if (!filePath) return res.status(400).json({ error: "No file" });
    const fullTextFlag = (req.body && (req.body.fullText === '1' || req.body.fullText === 'true')) ? true : false;
    const text = await extractText(filePath, mimetype);
    let messages;
    const PROMPT = buildPromptWithKB(SYSTEM_PROMPT);
    if (fullTextFlag) {
      messages = [ { role: 'system', content: PROMPT }, { role: 'user', content: text } ];
    } else {
      // standard path: either whole text (short) or chunked (long). For preview, показываем кратко как пойдет первый запрос.
      if (text.length < 15000) {
        messages = [ { role: 'system', content: PROMPT }, { role: 'user', content: text } ];
      } else {
        // build first chunk preview
        const CHUNK_SIZE = 1000; // same as config default; for precise, we could import
        const CHUNK_OVERLAP = 100;
        const first = text.slice(0, CHUNK_SIZE);
        const suffix = `Ты видишь фрагмент большого документа. Обрабатывай только явную информацию из фрагмента. Возвращай текст в тех же разделах 1–7. Никаких JSON/Markdown.`;
        messages = [ { role: 'system', content: `${PROMPT}\n\n${suffix}` }, { role: 'user', content: first } ];
      }
    }
    // cleanup temp upload file
    if (req.file?.path) { fs.unlink(req.file.path, () => {}); }
    return res.json({ messages, mode: fullTextFlag ? 'full_text' : 'standard', filename: originalname });
  } catch (e) {
    return res.status(500).json({ error: e.message });
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
app.get("/api/analyses/:file", async (req, res) => {
  const filePath = path.join("/tmp", "analysis_results", req.params.file);
  if (fs.existsSync(filePath)) {
    const data = fs.readFileSync(filePath, "utf-8");
    return res.type("application/json").send(data);
  }
  // Fallback to Blob storage if local temp is missing (serverless instance change)
  try {
    if (BLOB_READ_WRITE_TOKEN) {
      const { list } = await import('@vercel/blob');
      const result = await list({ prefix: `analyses/${req.params.file}`, token: BLOB_READ_WRITE_TOKEN, limit: 1 });
      const blob = (result?.blobs || [])[0];
      if (blob?.url) {
        const resp = await fetch(blob.url);
        if (resp.ok) {
          const text = await resp.text();
          return res.type("application/json").send(text);
        }
      }
    }
  } catch (e) {
    console.warn('blob_fetch_analysis_failed', e?.message || e);
  }
  return res.status(404).json({ error: "Not found" });
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
  // 2) Query Notion DB
  if (NOTION_TOKEN && NOTION_DATABASE_ID) {
    try {
      const notion = new NotionClient({ auth: NOTION_TOKEN });
      // Check if FileKey property exists
      let hasFileKey = false;
      try {
        const db = await notion.databases.retrieve({ database_id: NOTION_DATABASE_ID });
        hasFileKey = !!db?.properties?.["FileKey"];
      } catch {}

      if (hasFileKey) {
        try {
          const byFK = await notion.databases.query({
            database_id: NOTION_DATABASE_ID,
            filter: { property: "FileKey", rich_text: { equals: file } },
            sorts: [{ timestamp: "created_time", direction: "descending" }],
            page_size: 1,
          });
          if (byFK.results && byFK.results.length > 0) {
            const pageId = byFK.results[0].id;
            const pageUrl = `https://www.notion.so/${String(pageId).replace(/-/g,'')}`;
            return res.json({ status: "success", pageId, pageUrl });
          }
        } catch {
          // ignore and fallback to Name
        }
      }

      // Fallback: query by Name contains base filename
      const base = file.replace(/\.json$/i, "").replace(/_\d+$/, "");
      const byName = await notion.databases.query({
        database_id: NOTION_DATABASE_ID,
        filter: { property: "Name", title: { contains: base } },
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: 1,
      });
      if (byName.results && byName.results.length > 0) {
        const pageId = byName.results[0].id;
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