# V3 DC download diagnostic patch

- Passes the document's `dcId` explicitly to GramJS `iterDownload()` so download requests can be routed to the document's Telegram data center.
- Keeps the existing HTTP Range and streaming behavior unchanged.
- This is a targeted hypothesis based on repeated `File lives in another DC` logs. It must be validated against a real Telegram download after deployment.
- Keep the Blitz/Python backend available as fallback until playback is verified.
