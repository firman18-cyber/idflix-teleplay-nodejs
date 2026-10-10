require('dotenv').config();
const http = require('node:http');
const { URL } = require('node:url');
const { TelegramClient, Api } = require('telegram');
const bigInt = require('big-integer');
const { StringSession } = require('telegram/sessions');

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 8000);
const HOST = process.env.SERVER_HOST || '0.0.0.0';
const API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const HELPER_TOKENS = (process.env.TELEGRAM_HELPER_BOT_TOKENS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const CHAT_ID_RAW = process.env.TELEGRAM_CHAT_ID || '';
const STREAM_TOKEN = (process.env.STREAM_TOKEN || '').trim();
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*').trim();
const CLIENT_CONCURRENCY = Math.max(1, Number(process.env.TELEGRAM_CLIENT_CONCURRENCY || 3));
const CHUNK_SIZE = 1024 * 1024;
const TG_CHUNK_SIZE = 512 * 1024; // Telegram/GramJS download chunks must be aligned.

const clients = [];
let started = false;

function validateConfig() {
  const missing = [];
  if (!API_ID) missing.push('TELEGRAM_API_ID');
  if (!API_HASH) missing.push('TELEGRAM_API_HASH');
  if (!BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!CHAT_ID_RAW) missing.push('TELEGRAM_CHAT_ID');
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

function normalizeChatId(value) {
  if (!/^-?\d+$/.test(value)) throw new Error('TELEGRAM_CHAT_ID must be a numeric Telegram chat ID');
  return Number(value);
}
const CHAT_ID = (() => {
  try { return normalizeChatId(CHAT_ID_RAW); } catch { return null; }
})();

async function startTelegramClients() {
  validateConfig();
  const tokens = [BOT_TOKEN, ...HELPER_TOKENS];
  for (let i = 0; i < tokens.length; i++) {
    const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
      connectionRetries: 5,
      useWSS: false,
    });
    await client.start({ botAuthToken: tokens[i], onError: err => console.error(`Telegram client ${i} error:`, err?.message || err) });
    clients.push(client);
    console.log(`Telegram bot client ${i + 1}/${tokens.length} connected`);
  }
  started = true;
}

async function stopTelegramClients() {
  await Promise.allSettled(clients.map(c => c.disconnect()));
  started = false;
}

function getDocument(message) {
  const media = message?.media;
  if (!media || !media.document) return null;
  const doc = media.document;
  if (!(doc instanceof Api.Document)) return null;
  return doc;
}

function mediaInfo(message) {
  const doc = getDocument(message);
  if (!doc) throw Object.assign(new Error('Message does not contain streamable media'), { statusCode: 415 });
  const size = Number(doc.size || 0);
  if (!Number.isSafeInteger(size) || size <= 0) throw Object.assign(new Error('Media has no usable file size'), { statusCode: 415 });
  let filename = `telegram-${message.id}`;
  for (const attr of (doc.attributes || [])) {
    if (attr instanceof Api.DocumentAttributeFilename && attr.fileName) filename = attr.fileName;
  }
  return { document: doc, size, mime: doc.mimeType || 'application/octet-stream', filename };
}

async function getMessage(messageId) {
  if (!started || clients.length === 0) throw new Error('Telegram client is not started');
  let lastError;
  for (const client of clients) {
    try {
      const messages = await client.getMessages(CHAT_ID, { ids: [messageId] });
      const message = messages && messages[0];
      if (message && !message.className?.includes('Empty')) return message;
    } catch (err) {
      lastError = err;
      console.warn(`A Telegram client could not fetch message ${messageId}:`, err?.message || err);
    }
  }
  if (lastError) console.warn('Last Telegram lookup error:', lastError.message || lastError);
  throw Object.assign(new Error('Telegram message not found'), { statusCode: 404 });
}

function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) throw Object.assign(new Error('Invalid Range header'), { statusCode: 416, contentRange: `bytes */${size}` });
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) {
    throw Object.assign(new Error('Range not satisfiable'), { statusCode: 416, contentRange: `bytes */${size}` });
  }
  return { start, end: Math.min(requestedEnd, size - 1), partial: true };
}

function checkToken(url, req) {
  if (!STREAM_TOKEN) return;
  const auth = req.headers.authorization || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const supplied = url.searchParams.get('token') || bearer;
  if (supplied !== STREAM_TOKEN) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowed = CORS_ORIGINS === '*' ? '*' : CORS_ORIGINS.split(',').map(x => x.trim());
  const headers = {};
  if (CORS_ORIGINS === '*') headers['Access-Control-Allow-Origin'] = '*';
  else if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  headers['Access-Control-Allow-Methods'] = 'GET, HEAD, OPTIONS';
  headers['Access-Control-Allow-Headers'] = 'Authorization, Range, Content-Type';
  headers['Access-Control-Expose-Headers'] = 'Content-Range, Accept-Ranges, Content-Length, Content-Disposition';
  return headers;
}

async function* downloadRange(message, start, end) {
  const doc = getDocument(message);
  if (!doc) throw new Error('Telegram document is unavailable');
  const length = end - start + 1;
  let yielded = 0;
  let chunkIndex = Math.floor(start / CHUNK_SIZE);
  const lastChunkIndex = Math.floor(end / CHUNK_SIZE);
  const queue = [];
  for (let i = chunkIndex; i <= lastChunkIndex; i++) queue.push(i);
  const results = new Map();
  let nextYield = chunkIndex;
  let queueIndex = 0;
  const workerCount = Math.max(1, Math.min(CLIENT_CONCURRENCY, clients.length, queue.length));

  async function fetchChunk(index, workerNo) {
    const client = clients[workerNo % clients.length];
    const chunkStart = index * CHUNK_SIZE;
    const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, Number(doc.size)) - 1;
    const wantedLength = chunkEnd - chunkStart + 1;
    const pieces = [];
    let got = 0;
    const location = new Api.InputDocumentFileLocation({
      id: doc.id,
      accessHash: doc.accessHash,
      fileReference: doc.fileReference,
      thumbSize: '',
    });
    for await (const part of client.iterDownload({
      file: location,
      offset: bigInt(chunkStart),
      limit: wantedLength,
      chunkSize: TG_CHUNK_SIZE,
      requestSize: TG_CHUNK_SIZE,
    })) {
      const buf = Buffer.from(part);
      pieces.push(buf);
      got += buf.length;
      if (got >= wantedLength) break;
    }
    const data = Buffer.concat(pieces);
    if (data.length < wantedLength) throw new Error(`Telegram returned an incomplete chunk at offset ${chunkStart}`);
    return data.subarray(0, wantedLength);
  }

  const workers = Array.from({ length: workerCount }, async (_, workerNo) => {
    while (true) {
      const index = queue[queueIndex++];
      if (index === undefined) return;
      try { results.set(index, { data: await fetchChunk(index, workerNo) }); }
      catch (error) { results.set(index, { error }); }
    }
  });

  const allWorkers = Promise.all(workers);
  try {
    while (nextYield <= lastChunkIndex) {
      while (!results.has(nextYield)) {
        // Yielding chunks in order while concurrent workers fill the result map.
        await new Promise(resolve => setTimeout(resolve, 10));
        if (queueIndex >= queue.length && results.size === 0) break;
      }
      const result = results.get(nextYield);
      results.delete(nextYield);
      if (!result) throw new Error('Failed to retrieve Telegram chunk');
      if (result.error) throw result.error;
      let data = result.data;
      const chunkStart = nextYield * CHUNK_SIZE;
      const sliceStart = Math.max(0, start - chunkStart);
      const sliceEnd = Math.min(data.length, end - chunkStart + 1);
      data = data.subarray(sliceStart, sliceEnd);
      if (data.length) {
        yielded += data.length;
        yield data;
      }
      nextYield++;
      if (yielded >= length) break;
    }
  } finally {
    await allWorkers;
  }
}

function sendError(res, req, error) {
  if (res.headersSent) { res.destroy(error); return; }
  const status = error.statusCode || 500;
  const headers = { ...corsHeaders(req), 'Content-Type': 'application/json; charset=utf-8' };
  if (error.contentRange) headers['Content-Range'] = error.contentRange;
  res.writeHead(status, headers);
  res.end(JSON.stringify({ detail: status >= 500 ? 'Internal server error' : error.message }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors); res.end(); return;
  }
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'healthy', service: 'idflix-teleplay-nodejs' })); return;
  }
  const match = /^\/stream\/(\d+)$/.exec(url.pathname);
  if (!match || !['GET', 'HEAD'].includes(req.method || '')) {
    res.writeHead(404, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ detail: 'Not Found' })); return;
  }
  try {
    checkToken(url, req);
    const messageId = Number(match[1]);
    const message = await getMessage(messageId);
    const info = mediaInfo(message);
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...cors, 'Accept-Ranges': 'bytes', 'Content-Length': info.size,
        'Content-Type': info.mime, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(info.filename)}` });
      res.end(); return;
    }
    const { start, end, partial } = parseRange(req.headers.range, info.size);
    const length = end - start + 1;
    const disposition = info.mime.startsWith('video/') || info.mime.startsWith('audio/') ? 'inline' : 'attachment';
    res.writeHead(partial ? 206 : 200, { ...cors, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': length,
      'Content-Type': info.mime,
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(info.filename)}`,
      'Cache-Control': 'private, no-store' });
    for await (const chunk of downloadRange(message, start, end)) {
      if (res.destroyed) break;
      if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve));
    }
    if (!res.destroyed) res.end();
  } catch (error) {
    console.error('Request failed:', error?.message || error);
    sendError(res, req, error);
  }
});

async function shutdown(signal) {
  console.log(`${signal} received; shutting down`);
  server.close();
  await stopTelegramClients();
  process.exit(0);
}

(async () => {
  try {
    validateConfig();
    await startTelegramClients();
    server.listen(PORT, HOST, () => console.log(`IDFLIX TelePlay Node.js listening on ${HOST}:${PORT}`));
  } catch (error) {
    console.error('Startup failed:', error?.message || error);
    process.exit(1);
  }
})();
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
