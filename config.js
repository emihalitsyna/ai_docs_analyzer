/* config.js
 * Centralized configuration and environment variable handling.
 */
import dotenv from "dotenv";

// Load .env if present (does nothing on Vercel where env vars are injected)
dotenv.config();

const getEnv = (key, defaultValue = undefined) => {
  if (process.env[key]) return process.env[key];
  if (defaultValue !== undefined) return defaultValue;
  throw new Error(`Required environment variable ${key} is not set`);
};

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
export const OPENAI_MODEL = getEnv("OPENAI_MODEL", "gpt-5-mini");
export const OPENAI_MAX_TOKENS = Number(getEnv("OPENAI_MAX_TOKENS", "200000"));
export const OPENAI_TEMPERATURE = Number(getEnv("OPENAI_TEMPERATURE", "0.7"));

export const NOTION_TOKEN = process.env.NOTION_TOKEN || null;
export const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID || null;

export const VECTOR_DB_URL = process.env.VECTOR_DB_URL || null;
export const VECTOR_DB_API_KEY = process.env.VECTOR_DB_API_KEY || null;

export const CHUNK_SIZE = Number(getEnv("CHUNK_SIZE", "1000"));
export const CHUNK_OVERLAP = Number(getEnv("CHUNK_OVERLAP", "100"));

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// Retrieval / Assistants API
export const OPENAI_VECTOR_STORE = process.env.OPENAI_VECTOR_STORE || process.env.OPENAI_VECTOR_STORE_ID || null;
export const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || null;

export default {
  OPENAI_API_KEY,
  OPENAI_MODEL,
  OPENAI_MAX_TOKENS,
  OPENAI_TEMPERATURE,
  NOTION_TOKEN,
  NOTION_DATABASE_ID,
  VECTOR_DB_URL,
  VECTOR_DB_API_KEY,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  MAX_FILE_SIZE_BYTES,
  OPENAI_VECTOR_STORE,
  OPENAI_ASSISTANT_ID,
}; 