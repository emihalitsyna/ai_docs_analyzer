// api/extractText.js
import fs from "fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.js";
import mammoth from "mammoth";

/**
 * Extract text from a PDF file.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function extractPdf(filePath) {
  const data = new Uint8Array(fs.readFileSync(filePath));
  const pdf = await pdfjs.getDocument({ data }).promise;
  const maxPages = pdf.numPages;
  const pageTexts = [];
  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item) => item.str).join(" ");
    pageTexts.push(pageText);
  }
  return pageTexts.join("\n");
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