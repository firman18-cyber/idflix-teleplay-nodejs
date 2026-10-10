# Migration notes

- This folder is a separate Node.js experimental copy of `idflix-teleplay-main.zip`.
- Original Python source was left untouched in the original archive.
- Python/FastAPI/Pyrogram were replaced by Node.js native HTTP + GramJS.
- Existing route shapes, token check, health endpoint, Range response headers, Telegram bot token list, and CORS configuration were carried over conceptually.
- Differences/risks: the original Pyrogram patch for FloodWait does not have a direct one-to-one port here; GramJS retry/flood-wait behavior may differ. GramJS bot API access to group messages and `iterDownload` offsets must be verified in a real test.
- The initial code is an engineering draft, not a certified drop-in replacement. Keep the original Python backend unchanged.
