// 留言瓶回覆後台（/reply 頁面用）
//   GET  /api/admin             { ready: 已設密碼, authed: 已登入 }
//   GET  /api/admin?list=1      保留中的 200 則瓶子＋回覆（需登入）
//   POST /api/admin { op, ... } setup / login / logout / reply / password
// 沒有預設密碼：scripts/reply-setup.js 產生一次性設定連結，第一次打開時設定。
// 密碼只存 scrypt 雜湊；登入 session 綁目前密碼的 salt，改密碼或重設後舊 session 全部失效。
const crypto = require('crypto');
const { P, configured, redis, readBody } = require('./_redis');

const K_PW = P + 'reply:pw';           // scrypt$N$saltHex$hashHex
const K_SETUP = P + 'reply:setup';     // 設定 token 的 sha256（7 天）
const K_SESS = P + 'reply:sess:';      // + sha256(session token) → 目前密碼 salt（30 天）
const K_FAIL = P + 'reply:fail:';      // + ip：15 分鐘內失敗次數
const K_FAIL_ALL = P + 'reply:fail:all:'; // + 小時：全站失敗次數
const K_REPLIES = P + 'replies';
const K_BOTTLES = P + 'bottles';

const KEEP = 200, MAX_REPLY = 300;
const SESS_TTL = 30 * 86400;
const IP_MAX = 8, IP_WIN = 900, ALL_MAX = 60;
const COOKIE = 'isl_admin';
const ID = /^[a-z0-9]{6,24}$/;
const SCRYPT_N = 16384;

const { parseReplies, bottleIds } = require('./replies');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hexEq = (a, b) => {
  const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b || ''), 'hex');
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};
const scrypt = (pw, salt, N) => new Promise((ok, no) => {
  crypto.scrypt(pw, salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 + 1024 * 1024 }, (e, k) => (e ? no(e) : ok(k)));
});
// 不同裝置的輸入法可能給出不同組合的同一個字，統一成 NFC
const normPw = (s) => String(s).normalize('NFC');
const pwOk = (s) => typeof s === 'string' && s.length >= 8 && s.length <= 128;

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(normPw(pw), salt, SCRYPT_N);
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${key.toString('hex')}`;
}
async function verifyPassword(pw, rec) {
  const [alg, n, saltHex, hashHex] = String(rec || '').split('$');
  const N = Number(n);
  if (alg !== 'scrypt' || !(N >= 1024 && N <= 131072 && (N & (N - 1)) === 0)) return false;
  if (!/^[0-9a-f]{32}$/.test(saltHex || '') || !/^[0-9a-f]{64}$/.test(hashHex || '')) return false;
  const key = await scrypt(normPw(pw), Buffer.from(saltHex, 'hex'), N);
  return crypto.timingSafeEqual(key, Buffer.from(hashHex, 'hex'));
}
const saltOf = (rec) => String(rec || '').split('$')[2] || '';

// 回覆內容：同 bottles.js 的 clean，但保留換行
const cleanReply = (s) => String(s)
  .replace(/\r\n?/g, '\n')
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f<>]/g, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const first = (v) => String(v || '').split(',')[0].trim();
// 來源 IP：Cloudflare → X-Forwarded-For 第一段 → socket；只留 IP 會用到的字元當 key
function clientIp(req) {
  const raw = first(req.headers['cf-connecting-ip']) || first(req.headers['x-forwarded-for']) || (req.socket && req.socket.remoteAddress) || '';
  return raw.toLowerCase().replace(/[^0-9a-f:.]/g, '').slice(0, 45) || 'unknown';
}
function getCookie(req) {
  const hit = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  return hit ? hit.slice(COOKIE.length + 1) : '';
}
function setCookie(req, res, token, maxAge) {
  const secure = first(req.headers['x-forwarded-proto']).toLowerCase() === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/api/admin; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`);
}
// 有帶 Origin 時必須是本站（反向代理後看 X-Forwarded-Host，直連看 Host）
function sameOrigin(req) {
  const o = req.headers.origin;
  if (o === undefined) return true;
  let host;
  try { host = new URL(o).host.toLowerCase(); } catch (e) { return false; }
  const xf = first(req.headers['x-forwarded-host']).toLowerCase();
  const h = String(req.headers.host || '').toLowerCase();
  return Boolean(host) && (host === xf || host === h);
}

async function newSession(req, res, salt) {
  const token = crypto.randomBytes(32).toString('base64url');
  await redis([['SET', K_SESS + sha(token), salt, 'EX', SESS_TTL]]);
  setCookie(req, res, token, SESS_TTL);
}
// 回傳目前 session 的 key 與密碼紀錄；無效回 null
async function getSession(req) {
  const tok = getCookie(req);
  if (!/^[A-Za-z0-9_-]{43}$/.test(tok)) return null;
  const key = K_SESS + sha(tok);
  const [v, pw] = await redis([['GET', key], ['GET', K_PW]]);
  if (!v || !pw || v !== saltOf(pw)) return null;
  return { key, pw };
}

// 失敗次數限制：先查再驗，失敗才累加
const hourKey = () => K_FAIL_ALL + Math.floor(Date.now() / 3600e3);
const limited = (ipFails, allFails) => Number(ipFails) >= IP_MAX || Number(allFails) >= ALL_MAX;
async function recordFail(ip) {
  const hk = hourKey();
  await redis([['INCR', K_FAIL + ip], ['EXPIRE', K_FAIL + ip, IP_WIN], ['INCR', hk], ['EXPIRE', hk, 7200]]);
}

// 讀瓶子＋回覆；順手把已經被擠出 200 則（或被後台刪掉）的瓶子的回覆清掉
async function readBottles() {
  const [list, flat] = await redis([['LRANGE', K_BOTTLES, 0, KEEP - 1], ['HGETALL', K_REPLIES]]);
  const bottles = (list || []).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter((b) => b && typeof b.id === 'string');
  const ids = bottleIds(list), orphans = [];
  for (let i = 0; i < (flat || []).length; i += 2) if (!ids.has(String(flat[i]))) orphans.push(String(flat[i]));
  if (orphans.length) await redis([['HDEL', K_REPLIES, ...orphans]]);
  return { bottles, replies: parseReplies(flat) };
}

const OPS = {
  async setup(req, res, b) {
    if (typeof b.token !== 'string' || !b.token || b.token.length > 128 || typeof b.password !== 'string') return res.status(400).json({ error: 'bad request' });
    const [pw, setup] = await redis([['GET', K_PW], ['GET', K_SETUP]]);
    if (pw) return res.status(409).json({ error: 'already set' });
    if (!setup || !hexEq(sha(b.token), setup)) return res.status(403).json({ error: 'bad token' });
    if (!pwOk(b.password)) return res.status(400).json({ error: 'bad password' });
    const rec = await hashPassword(b.password);
    // NX：同時有兩個人用同一條連結設定時只有一個成功
    const [ok] = await redis([['SET', K_PW, rec, 'NX'], ['DEL', K_SETUP]]);
    if (ok !== 'OK') return res.status(409).json({ error: 'already set' });
    await newSession(req, res, saltOf(rec));
    return res.status(200).json({ ok: true });
  },

  async login(req, res, b) {
    if (typeof b.password !== 'string') return res.status(400).json({ error: 'bad request' });
    const ip = clientIp(req);
    const [fi, fa, pw] = await redis([['GET', K_FAIL + ip], ['GET', hourKey()], ['GET', K_PW]]);
    if (limited(fi, fa)) return res.status(429).json({ error: 'too many attempts' });
    if (!pw) return res.status(409).json({ error: 'not ready' });
    if (!(await verifyPassword(b.password, pw))) {
      await recordFail(ip);
      return res.status(401).json({ error: 'wrong password' });
    }
    await redis([['DEL', K_FAIL + ip]]);
    await newSession(req, res, saltOf(pw));
    return res.status(200).json({ ok: true });
  },

  async logout(req, res) {
    const tok = getCookie(req);
    if (tok) await redis([['DEL', K_SESS + sha(tok)]]);
    setCookie(req, res, '', 0);
    return res.status(200).json({ ok: true });
  },

  async reply(req, res, b, sess) {
    if (!sess) return res.status(401).json({ error: 'unauthorized' });
    const id = String(b.id || '');
    if (typeof b.text !== 'string') return res.status(400).json({ error: 'bad request' });
    if (!ID.test(id)) return res.status(404).json({ error: 'not found' });
    const text = cleanReply(b.text);
    if (text.length > MAX_REPLY) return res.status(400).json({ error: 'too long' });
    // 刪除不檢查瓶子還在不在（瓶子被擠出 200 則後也要能刪）
    if (!text) {
      await redis([['HDEL', K_REPLIES, id]]);
      return res.status(200).json({ id, deleted: true });
    }
    const [list] = await redis([['LRANGE', K_BOTTLES, 0, KEEP - 1]]);
    if (!bottleIds(list).has(id)) return res.status(404).json({ error: 'not found' });
    const reply = { text, t: Date.now() };
    await redis([['HSET', K_REPLIES, id, JSON.stringify(reply)]]);
    return res.status(200).json({ id, reply });
  },

  // 改密碼：換新 salt，所有舊 session 自動失效，這個瀏覽器換發新 session
  async password(req, res, b, sess) {
    if (!sess) return res.status(401).json({ error: 'unauthorized' });
    if (typeof b.old !== 'string' || typeof b.password !== 'string') return res.status(400).json({ error: 'bad request' });
    if (!pwOk(b.password)) return res.status(400).json({ error: 'bad password' });
    const ip = clientIp(req);
    const [fi, fa] = await redis([['GET', K_FAIL + ip], ['GET', hourKey()]]);
    if (limited(fi, fa)) return res.status(429).json({ error: 'too many attempts' });
    if (!(await verifyPassword(b.old, sess.pw))) {
      await recordFail(ip);
      return res.status(403).json({ error: 'wrong password' });
    }
    const rec = await hashPassword(b.password);
    await redis([['SET', K_PW, rec], ['DEL', sess.key]]);
    await newSession(req, res, saltOf(rec));
    return res.status(200).json({ ok: true });
  },
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(503).json({ error: 'not configured' });
  if (req.method !== 'GET' && req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method not allowed' }); }
  if (req.method === 'POST') {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') return res.status(415).json({ error: 'unsupported media type' });
    if (!sameOrigin(req)) return res.status(403).json({ error: 'forbidden' });
  }
  try {
    if (req.method === 'GET') {
      const list = new URL(req.url || '/', 'http://x').searchParams.get('list') === '1';
      const sess = await getSession(req);
      if (!list) {
        const [pw] = sess ? [true] : await redis([['GET', K_PW]]);
        return res.status(200).json({ ready: Boolean(pw), authed: Boolean(sess) });
      }
      if (!sess) return res.status(401).json({ error: 'unauthorized' });
      const { bottles, replies } = await readBottles();
      return res.status(200).json({
        bottles: bottles.map((x) => {
          const o = { id: x.id, t: Number(x.t) || 0, name: String(x.name || ''), text: String(x.text || '') };
          if (Object.prototype.hasOwnProperty.call(replies, x.id)) o.reply = replies[x.id];
          return o;
        })
      });
    }
    const raw = readBody(req);
    const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const op =Object.prototype.hasOwnProperty.call(OPS, b.op) ? OPS[b.op] : null;
    if (!op) return res.status(400).json({ error: 'bad op' });
    const sess = (b.op === 'reply' || b.op === 'password') ? await getSession(req) : null;
    return await op(req, res, b, sess);
  } catch (e) {
    return res.status(502).json({ error: 'storage error' });
  }
};
