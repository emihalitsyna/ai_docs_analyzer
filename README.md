# AI Doc Analyzer

Веб-сервис для загрузки PDF/DOCX технической документации и получения структурированного анализа на базе OpenAI.

## Запуск локально

```bash
npm install
OPENAI_API_KEY=sk-... npm run dev
```

Откройте `http://localhost:3000` в браузере.

## Переменные окружения

* `OPENAI_API_KEY` — обязательный ключ.
* `OPENAI_MODEL` (по умолчанию gpt-4o-mini)
* `NOTION_TOKEN` и `NOTION_DATABASE_ID` — опционально для экспорта.
* `CHUNK_SIZE`, `CHUNK_OVERLAP` и т.д. — см. `config.js`.

## Деплой на Vercel

1. Создайте новый проект, укажите этот репозиторий.
2. Пропишите переменные окружения.
3. Vercel автоматически развернёт serverless-функцию из `api/server.js` и статический фронтенд из `public/`.

## Лицензия
MIT 