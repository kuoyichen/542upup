// Zeabur 用的零依賴 server：靜態首頁 + 轉接 Vercel 風格的 api handler
const http = require('http');
const fs = require('fs');
const path = require('path');

// 本機開發：載入 .env，不存在就略過；已存在的 env 不覆蓋（loadEnvFile 本身即不覆蓋）
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (e) { /* 無 .env */ }

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const MAX_BODY = 16 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const ROUTES = {
  '/api/track': require('./api/track.js'),
  '/api/bottles': require('./api/bottles.js'),
};

// 補上 Vercel 風格的 res.status() / res.json()
function shim(res) {
  res.status = (n) => { res.statusCode = n; return res; };
  res.json = (obj) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

function send(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readBody(req, cb) {
  const chunks = [];
  let size = 0;
  let done = false;
  req.on('data', (c) => {
    if (done) return;
    size += c.length;
    if (size > MAX_BODY) {
      done = true;
      cb(new Error('too large'));
      req.resume();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => { if (!done) { done = true; cb(null, Buffer.concat(chunks).toString('utf8')); } });
  req.on('error', () => { if (!done) { done = true; cb(new Error('read error')); } });
}

function serveApi(handler, req, res) {
  shim(res);
  const run = (body) => {
    if (body !== undefined) req.body = body;
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((e) => {
        console.error('handler error:', e && e.message);
        if (!res.headersSent) res.status(500).json({ error: 'internal error' });
        else res.end();
      });
  };
  if (req.method === 'GET' || req.method === 'HEAD') return run();
  readBody(req, (err, body) => {
    if (err) {
      if (err.message === 'too large') {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
        return res.end(JSON.stringify({ error: 'payload too large' }));
      }
      return send(res, 400, 'bad request');
    }
    run(body);
  });
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return send(res, 405, 'method not allowed');
  }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { return send(res, 404, 'not found'); }
  if (rel === '/') rel = '/index.html';
  const parts = rel.split('/').slice(1);
  // 只允許根目錄第一層、無 dot 開頭段、副檔名在白名單
  if (parts.length !== 1 || !parts[0] || parts[0].startsWith('.') || rel.includes('\0') || rel.includes('\\')) {
    return send(res, 404, 'not found');
  }
  const ext = path.extname(parts[0]).toLowerCase();
  const type = TYPES[ext];
  if (!type) return send(res, 404, 'not found');
  const file = path.join(ROOT, parts[0]);
  if (path.dirname(file) !== ROOT) return send(res, 404, 'not found');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { return send(res, 400, 'bad request'); }
  const handler = ROUTES[pathname];
  if (handler) return serveApi(handler, req, res);
  serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => console.log('listening on ' + PORT));
