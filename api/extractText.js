// api/extractText.js
import fs from "fs";
import pdfParse from "pdf-parse";
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

export default async function extractText(filePath, mimetype) {
  if (mimetype === "application/pdf") return extractPdf(filePath);
  if (mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return extractDocx(filePath);
  throw new Error("Unsupported file type");
} 