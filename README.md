# IDFLIX TelePlay — Node.js experimental copy

This is a **separate experimental Node.js port**. The original Python/FastAPI project is not modified. It uses Node.js and GramJS (Telegram MTProto) and exposes:

- `GET /health`
- `HEAD /stream/:messageId`
- `GET /stream/:messageId` with HTTP byte ranges

## Required environment variables

- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Optional: `TELEGRAM_HELPER_BOT_TOKENS` (comma-separated), `STREAM_TOKEN`, `TELEGRAM_CLIENT_CONCURRENCY`, `CORS_ORIGINS`, and `PORT`.

Set secrets in the hosting provider's environment-variable panel. **Do not upload a real `.env` file or commit Telegram credentials to GitHub.**

## Run locally

```sh
npm install
cp .env.example .env
# Fill in .env locally
npm start
```

The service loads `.env` locally using `dotenv`. On hosting, set the same values through the provider environment-variable panel.

## Deployment

The included Dockerfile is for platforms that support Dockerfile deployments. For a Node.js runtime that builds from a repository, use the `start` script in `package.json` and ensure dependencies are installed with `npm install`.

## Important status

This is a first-pass conversion and **has not been integration-tested against the actual Telegram group or hosting provider**. GramJS behavior for bot access, media file references, and partial downloads must be tested before relying on it. Keep the Python project as the known original and do not replace it until this copy passes health, Telegram lookup, `HEAD`, Range, seek, and long-playback tests.
