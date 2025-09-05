# AI Doc Analyzer

Веб-сервис для загрузки PDF/DOCX технической документации и получения структурированного анализа на базе OpenAI.

## Возможности
- Загрузка PDF и DOCX (drag & drop), прогресс и валидация размеров/типа
- Анализ всего документа с извлечением структурированных разделов:
  - Наименование заказчика, описание документа, ссылка на оригинальное ТЗ
  - Технические/функциональные/нефункциональные/инфраструктурные требования
  - Ограничения и риски, сроки/стоимость
  - Необходимые документы и поля
  - Требуемые доработки и сопоставление с возможностями Dbrain
- Retrieval-режим: OpenAI Vector Store/Assistants для поиска по загруженному файлу
- Экспорт в Notion (создание страницы и свойств базы):
  - Описание, Ссылка на ТЗ, Контакты, Доработки, Сопоставление с Dbrain
- История анализов: Notion-страницы + локальные файлы (MVP)
- Опциональная загрузка оригинала в Vercel Blob и проставление ссылки в анализ/Notion

## Запуск локально

```bash
npm install
OPENAI_API_KEY=sk-... npm run dev
```

Откройте `http://localhost:3000` в браузере.

## Переменные окружения

Обязательные/основные:
- `OPENAI_API_KEY` — ключ OpenAI
- `OPENAI_MODEL` — модель (по умолчанию `gpt-5-mini`)
- `OPENAI_MAX_TOKENS` — лимит токенов ответа (по умолчанию 20000)
- `OPENAI_TEMPERATURE` — температура (по умолчанию 0.2)

Notion (опционально, для экспорта и истории):
- `NOTION_TOKEN` — токен интеграции
- `NOTION_DATABASE_ID` — ID базы данных

Retrieval (опционально):
- `OPENAI_VECTOR_STORE` или `OPENAI_VECTOR_STORE_ID` — ID Vector Store
- `OPENAI_ASSISTANT_ID` — ID ассистента (если используете Assistants)

Хранилище исходников (опционально):
- `BLOB_READ_WRITE_TOKEN` — токен Vercel Blob для публичной загрузки

Аналитика и чанкинг:
- `CHUNK_SIZE` (по умолчанию 1000), `CHUNK_OVERLAP` (по умолчанию 100)
- `MAX_FILE_SIZE_BYTES` или `MAX_FILE_SIZE_MB` — лимит загрузки (по умолчанию 25MB)

База знаний Dbrain (опционально):
- `DBRAIN_KB_PATH` — путь к JSON-файлу с возможностями Dbrain (по умолчанию `kb/dbrain_capabilities.json`)

## Архитектура
- Бэкенд: `api/server.js` (Express, serverless-совместимый)
- Аналитика: `api/analysis.js` (модель + Retrieval), `api/retrieval.js`
- Парсинг файлов: `api/extractText.js`
- Фронтенд: `public/index.html` (простая страница, история, Notion-ссылка)

## Эндпоинты
- `POST /api/upload` — загрузить документ и выполнить анализ
- `GET /api/analyses` — история (Notion-страницы + локальные файлы)
- `GET /api/analyses/:file` — получить конкретный локальный анализ
- `GET /api/notion-status/:file` — статус экспорта в Notion (с `pageUrl`)
- `GET /api/status` — состояние сервисов (OpenAI/Notion)
- `POST /api/diag/notion-fix` — привести схему базы Notion к нужному виду

## Деплой на Vercel
1. Создайте новый проект, укажите этот репозиторий
2. Пропишите переменные окружения в проекте
3. Vercel развернёт serverless-функцию из `api/server.js` и статический фронтенд из `public/`

## Лицензия
MIT 