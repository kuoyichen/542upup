// 本機開發用的假 Upstash REST（只放記憶體，關掉就消失），避免碰到正式資料庫
//   node dev/fake-upstash.js [--port 8079] [--seed dev/sample-bottles.json]
// 再用 KV_REST_API_URL=http://127.0.0.1:8079 KV_REST_API_TOKEN=dev node server.js 啟動網站。
// 只實作 POST /pipeline 與 track.js、bottles.js、replies.js、admin.js 用到的指令；token 不檢查。
// seed：瓶子物件陣列（新到舊），物件可帶 reply: { text, t, by } 一併寫入回覆（沒有 by＝舊版回覆）。
const http = require('http');
const fs = require('fs');

const P = '542upup:';

function createStore() {
  const data = new Map(); // key → { type, v, exp }
  const live = (k) => {
    const e = data.get(k);
    if (e && e.exp && e.exp <= Date.now()) { data.delete(k); return undefined; }
    return e;
  };
  const typed = (k, type, make) => {
    let e = live(k);
    if (e && e.type !== type) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    if (!e && make) { e = { type, v: make(), exp: 0 }; data.set(k, e); }
    return e;
  };
  const int = (x) => {
    const n = Number(x);
    if (!Number.isInteger(n)) throw new Error('ERR value is not an integer or out of range');
    return n;
  };
  const range = (len, a, b) => {
    let s = int(a), e = int(b);
    if (s < 0) s = Math.max(0, len + s);
    if (e < 0) e = len + e;
    e = Math.min(e, len - 1);
    return [s, e];
  };
  const incrby = (k, by) => {
    const e = typed(k, 'string', () => '0');
    const n = int(e.v) + by;
    e.v = String(n);
    return n;
  };

  const CMDS = {
    GET: (k) => { const e = typed(k, 'string'); return e ? e.v : null; },
    SET: (k, v, ...opt) => {
      let nx = false, xx = false, ttl = 0, get = false;
      for (let i = 0; i < opt.length; i++) {
        const o = String(opt[i]).toUpperCase();
        if (o === 'NX') nx = true;
        else if (o === 'XX') xx = true;
        else if (o === 'GET') get = true;
        else if (o === 'EX') ttl = int(opt[++i]) * 1000;
        else if (o === 'PX') ttl = int(opt[++i]);
        else throw new Error('ERR syntax error');
      }
      const old = live(k);
      if ((nx && old) || (xx && !old)) return null;
      data.set(k, { type: 'string', v: String(v), exp: ttl ? Date.now() + ttl : 0 });
      return get ? (old ? old.v : null) : 'OK';
    },
    DEL: (...ks) => ks.reduce((n, k) => n + (live(k) && data.delete(k) ? 1 : 0), 0),
    EXISTS: (...ks) => ks.reduce((n, k) => n + (live(k) ? 1 : 0), 0),
    INCR: (k) => incrby(k, 1),
    INCRBY: (k, by) => incrby(k, int(by)),
    EXPIRE: (k, s) => { const e = live(k); if (!e) return 0; e.exp = Date.now() + int(s) * 1000; return 1; },
    TTL: (k) => { const e = live(k); if (!e) return -2; return e.exp ? Math.ceil((e.exp - Date.now()) / 1000) : -1; },
    MGET: (...ks) => ks.map((k) => { const e = live(k); return e && e.type === 'string' ? e.v : null; }),
    // HyperLogLog 用 Set 近似（本機資料量小，精確計數即可）
    PFADD: (k, ...m) => { const e = typed(k, 'hll', () => new Set()); const n = e.v.size; m.forEach((x) => e.v.add(String(x))); return e.v.size > n ? 1 : 0; },
    PFCOUNT: (...ks) => { const u = new Set(); ks.forEach((k) => { const e = typed(k, 'hll'); if (e) e.v.forEach((x) => u.add(x)); }); return u.size; },
    LPUSH: (k, ...vs) => { const e = typed(k, 'list', () => []); vs.forEach((v) => e.v.unshift(String(v))); return e.v.length; },
    LTRIM: (k, a, b) => {
      const e = typed(k, 'list');
      if (!e) return 'OK';
      const [s, t] = range(e.v.length, a, b);
      e.v = s > t ? [] : e.v.slice(s, t + 1);
      if (!e.v.length) data.delete(k);
      return 'OK';
    },
    LRANGE: (k, a, b) => {
      const e = typed(k, 'list');
      if (!e) return [];
      const [s, t] = range(e.v.length, a, b);
      return s > t ? [] : e.v.slice(s, t + 1);
    },
    HSET: (k, ...fv) => {
      if (!fv.length || fv.length % 2) throw new Error('ERR wrong number of arguments for \'hset\' command');
      const e = typed(k, 'hash', () => new Map());
      let n = 0;
      for (let i = 0; i < fv.length; i += 2) { if (!e.v.has(String(fv[i]))) n++; e.v.set(String(fv[i]), String(fv[i + 1])); }
      return n;
    },
    HGET: (k, f) => { const e = typed(k, 'hash'); return e && e.v.has(String(f)) ? e.v.get(String(f)) : null; },
    // Upstash REST 的 HGETALL 是攤平陣列
    HGETALL: (k) => { const e = typed(k, 'hash'); return e ? [...e.v].flat() : []; },
    HDEL: (k, ...fs_) => {
      const e = typed(k, 'hash');
      if (!e) return 0;
      const n = fs_.reduce((c, f) => c + (e.v.delete(String(f)) ? 1 : 0), 0);
      if (!e.v.size) data.delete(k);
      return n;
    },
    FLUSHALL: () => { data.clear(); return 'OK'; },
  };

  function exec(cmd) {
    if (!Array.isArray(cmd) || !cmd.length) return { error: 'ERR empty command' };
    const fn = CMDS[String(cmd[0]).toUpperCase()];
    if (!fn) return { error: 'ERR unknown command \'' + cmd[0] + '\'' };
    try { return { result: fn(...cmd.slice(1).map(String)) }; } catch (e) { return { error: e.message }; }
  }
  return { data, exec, run: (...cmd) => { const r = exec(cmd); if (r.error) throw new Error(r.error); return r.result; } };
}

// 瓶子物件 → 跟 bottles.js 寫入的格式一樣（陣列第 0 個最新）
function seed(store, bottles) {
  const now = Date.now();
  const list = bottles.map((b, i) => ({
    id: b.id || (now - i * 3600e3).toString(36) + Math.random().toString(36).slice(2, 6),
    t: b.t || now - i * 3600e3,
    text: String(b.text || ''),
    name: String(b.name || '匿名鎮民'),
    reply: b.reply,
  }));
  for (const b of list.slice().reverse()) store.run('LPUSH', P + 'bottles', JSON.stringify({ id: b.id, t: b.t, text: b.text, name: b.name }));
  for (const b of list) {
    if (!b.reply || !b.reply.text) continue;
    const r = { text: String(b.reply.text), t: b.reply.t || now };
    if (b.reply.by) r.by = String(b.reply.by);
    store.run('HSET', P + 'replies', b.id, JSON.stringify(r));
  }
  return list.length;
}

function createFakeUpstash() {
  const store = createStore();
  const state = { broken: false, requests: 0 };
  const server = http.createServer((req, res) => {
    const out = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method !== 'POST' || new URL(req.url, 'http://x').pathname !== '/pipeline') return out(404, { error: 'not found' });
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      state.requests++;
      if (state.broken) return out(500, { error: 'fake outage' });
      let cmds;
      try { cmds = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return out(400, { error: 'ERR bad json' }); }
      if (!Array.isArray(cmds)) return out(400, { error: 'ERR pipeline must be an array' });
      out(200, cmds.map(store.exec));
    });
  });
  return { server, store, state, seed: (bottles) => seed(store, bottles) };
}

module.exports = { createFakeUpstash, createStore };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const port = Number(opt('--port')) || 8079;
  const host = opt('--host') || '127.0.0.1';
  const fake = createFakeUpstash();
  const seedFile = opt('--seed');
  if (seedFile) console.log('seed：' + fake.seed(JSON.parse(fs.readFileSync(seedFile, 'utf8'))) + ' 個瓶子');
  fake.server.listen(port, host, () => console.log(`fake upstash：http://${host}:${port}（記憶體，關掉即清空）`));
}
