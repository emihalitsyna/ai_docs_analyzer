// api/extractText.js
import fs from "fs";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";

/**
 * Extract text from a PDF file.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function extractPdf(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const { text } = await pdfParse(dataBuffer);
  return text;
}

/**
 * Extract text from a DOCX file.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function extractDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

function extractUtf8(filePath){
  return fs.readFileSync(filePath, 'utf-8');
}

export default async function extractText(filePath, mimetype) {
  if (mimetype === "application/pdf") return extractPdf(filePath);
  if (mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return extractDocx(filePath);
  // CSV and plain text support
  if (mimetype === "text/csv" || mimetype === "text/plain" || mimetype === "application/csv" || mimetype === "application/vnd.ms-excel") return extractUtf8(filePath);
  // Fallback by extension for some environments
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) return extractUtf8(filePath);
  throw new Error("Unsupported file type");
} 