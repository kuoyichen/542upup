// 留言瓶回覆後台（/reply 頁面用），帳號制：每個帳號有自己的密碼與登入
//   GET  /api/admin             { ready: 至少一個帳號設好密碼, authed: 已登入, user: { name, display } | null }
//   GET  /api/admin?list=1      保留中的 200 則瓶子＋回覆（需登入）
//   POST /api/admin { op, ... } setupinfo / setup / login / logout / reply / password
// 帳號由 scripts/reply-setup.js 建立（沒有密碼），用一次性設定連結設定密碼；伺服器不寫死帳號名單。
// 密碼只存 scrypt 雜湊；session 綁「帳號＋該帳號目前密碼的 salt」，改密碼或用重設連結後只有該帳號的 session 失效。
const crypto = require('crypto');
const { P, configured, redis, readBody } = require('./_redis');
const { parseReplies, bottleIds } = require('./replies');

const K_USERS = P + 'reply:users';     // hash：帳號 → JSON { display, pw: 'scrypt$N$saltHex$hashHex' 或 '', t }
const K_SETUP = P + 'reply:setup:';    // + 帳號 → 設定 token 的 sha256（7 天，重發即覆蓋）
const K_SESS = P + 'reply:sess:';      // + sha256(session token) → 帳號:密碼 salt（30 天）
const K_FAIL = P + 'reply:fail:';      // + ip：15 分鐘內失敗次數
const K_FAIL_ALL = P + 'reply:fail:all:'; // + 小時：全站失敗次數
const K_REPLIES = P + 'replies';
const K_BOTTLES = P + 'bottles';

const KEEP = 200, MAX_REPLY = 300;
const SESS_TTL = 30 * 86400;
const IP_MAX = 8, IP_WIN = 900, ALL_MAX = 60;
const COOKIE = 'isl_admin';
const ID = /^[a-z0-9]{6,24}$/;
const USER = /^[a-z0-9_]{2,32}$/;
const SCRYPT_N = 16384;

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
// 帳號不分大小寫、去頭尾空白（手機鍵盤常自動大寫或多一個空格）
const normUser = (s) => String(s || '').trim().toLowerCase();

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
// 帳號不存在或還沒設密碼時拿來驗的假雜湊（載入時先算好，回應時間才一致）
let dummy = null;
const dummyRec = () => (dummy = dummy || hashPassword(crypto.randomBytes(16).toString('hex')));
dummyRec().catch(() => { dummy = null; });

function parseUser(raw) {
  try {
    const u = JSON.parse(raw);
    if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
    return { ...u, display: String(u.display || ''), pw: typeof u.pw === 'string' ? u.pw : '' };
  } catch (e) { return null; }
}
function parseUsers(flat) {
  const users = new Map();
  const a = Array.isArray(flat) ? flat : [];
  for (let i = 0; i + 1 < a.length; i += 2) { const u = parseUser(a[i + 1]); if (u) users.set(String(a[i]), u); }
  return users;
}
const who = (name, u) => ({ name, display: (u && u.display) || name });

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

async function newSession(req, res, name, salt) {
  const token = crypto.randomBytes(32).toString('base64url');
  await redis([['SET', K_SESS + sha(token), name + ':' + salt, 'EX', SESS_TTL]]);
  setCookie(req, res, token, SESS_TTL);
}
// 讀全部帳號＋目前 session；session 無效時 sess 為 null
async function getState(req) {
  const tok = getCookie(req);
  const key = /^[A-Za-z0-9_-]{43}$/.test(tok) ? K_SESS + sha(tok) : '';
  const [flat, v] = await redis(key ? [['HGETALL', K_USERS], ['GET', key]] : [['HGETALL', K_USERS]]);
  const users = parseUsers(flat);
  let sess = null;
  const i = typeof v === 'string' ? v.lastIndexOf(':') : -1;
  if (i > 0) {
    const name = v.slice(0, i), u = users.get(name);
    if (u && u.pw && v.slice(i + 1) === saltOf(u.pw)) sess = { key, name, u };
  }
  return { users, sess };
}

// 失敗次數限制：先查再驗，失敗才累加
const hourKey = () => K_FAIL_ALL + Math.floor(Date.now() / 3600e3);
const limited = (ipFails, allFails) => Number(ipFails) >= IP_MAX || Number(allFails) >= ALL_MAX;
async function recordFail(ip) {
  const hk = hourKey();
  await redis([['INCR', K_FAIL + ip], ['EXPIRE', K_FAIL + ip, IP_WIN], ['INCR', hk], ['EXPIRE', hk, 7200]]);
}

// 設定連結＝帳號＋token；token 對得上該帳號目前的設定 key 才有效（重發後舊連結自然失效）
async function checkSetup(b) {
  const name = normUser(b.user);
  if (!USER.test(name) || typeof b.token !== 'string' || !b.token || b.token.length > 128) return null;
  const [raw, h] = await redis([['HGET', K_USERS, name], ['GET', K_SETUP + name]]);
  const u = parseUser(raw);
  if (!u || !h || !hexEq(sha(b.token), h)) return null;
  return { name, u };
}

// 讀瓶子＋回覆；順手把已經被擠出 200 則（或被後台刪掉）的瓶子的回覆清掉
async function readBottles() {
  const [list, flat] = await redis([['LRANGE', K_BOTTLES, 0, KEEP - 1], ['HGETALL', K_REPLIES]]);
  const bottles = (list || []).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter((b) => b && typeof b.id === 'string');
  const ids = bottleIds(list), orphans = [];
  for (let i = 0; i < (flat || []).length; i += 2) if (!ids.has(String(flat[i]))) orphans.push(String(flat[i]));
  if (orphans.length) await redis([['HDEL', K_REPLIES, ...orphans]]);
  return { bottles, replies: parseReplies(flat, true) };
}
// 後台看到的回覆多一個 byName（存檔帳號的顯示名稱）；舊回覆沒有 by 就不給
function withBy(reply, users) {
  if (!reply.by) return reply;
  return { ...reply, byName: who(reply.by, users.get(reply.by)).display };
}

const OPS = {
  // 打開設定連結時先問這條連結是哪個帳號的（連結無效一律 403，不透露帳號存不存在）
  async setupinfo(req, res, b) {
    const s = await checkSetup(b);
    if (!s) return res.status(403).json({ error: 'bad token' });
    return res.status(200).json({ user: who(s.name, s.u) });
  },

  async setup(req, res, b) {
    if (typeof b.password !== 'string') return res.status(400).json({ error: 'bad request' });
    const s = await checkSetup(b);
    if (!s) return res.status(403).json({ error: 'bad token' });
    if (!pwOk(b.password)) return res.status(400).json({ error: 'bad password' });
    const rec = await hashPassword(b.password);
    // DEL 回傳 1 才算搶到這條連結：同一條連結同時送出兩次只有一個成功
    const [n] = await redis([['DEL', K_SETUP + s.name]]);
    if (n !== 1) return res.status(403).json({ error: 'bad token' });
    await redis([['HSET', K_USERS, s.name, JSON.stringify({ ...s.u, pw: rec })]]);
    await newSession(req, res, s.name, saltOf(rec));
    return res.status(200).json({ ok: true, user: who(s.name, s.u) });
  },

  async login(req, res, b) {
    if (typeof b.username !== 'string' || typeof b.password !== 'string') return res.status(400).json({ error: 'bad request' });
    const name = normUser(b.username);
    const valid = USER.test(name);
    const ip = clientIp(req);
    const [fi, fa, raw] = await redis([['GET', K_FAIL + ip], ['GET', hourKey()], ['HGET', K_USERS, valid ? name : '']]);
    if (limited(fi, fa)) return res.status(429).json({ error: 'too many attempts' });
    const u = valid ? parseUser(raw) : null;
    // 帳號不存在或還沒設密碼時也對假雜湊跑一次 scrypt，回應時間才不會洩漏哪些帳號存在
    const ok = (await verifyPassword(b.password, (u && u.pw) || await dummyRec())) && Boolean(u && u.pw);
    if (!ok) {
      await recordFail(ip);
      return res.status(401).json({ error: 'bad credentials' });
    }
    await redis([['DEL', K_FAIL + ip]]);
    await newSession(req, res, name, saltOf(u.pw));
    return res.status(200).json({ ok: true, user: who(name, u) });
  },

  async logout(req, res) {
    const tok = getCookie(req);
    if (tok) await redis([['DEL', K_SESS + sha(tok)]]);
    setCookie(req, res, '', 0);
    return res.status(200).json({ ok: true });
  },

  async reply(req, res, b, st) {
    const sess = st && st.sess;
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
    const reply = { text, t: Date.now(), by: sess.name };
    await redis([['HSET', K_REPLIES, id, JSON.stringify(reply)]]);
    return res.status(200).json({ id, reply: withBy(reply, st.users) });
  },

  // 改密碼：該帳號換新 salt，只有這個帳號的舊 session 失效，這個瀏覽器換發新 session
  async password(req, res, b, st) {
    const sess = st && st.sess;
    if (!sess) return res.status(401).json({ error: 'unauthorized' });
    if (typeof b.old !== 'string' || typeof b.password !== 'string') return res.status(400).json({ error: 'bad request' });
    if (!pwOk(b.password)) return res.status(400).json({ error: 'bad password' });
    const ip = clientIp(req);
    const [fi, fa] = await redis([['GET', K_FAIL + ip], ['GET', hourKey()]]);
    if (limited(fi, fa)) return res.status(429).json({ error: 'too many attempts' });
    if (!(await verifyPassword(b.old, sess.u.pw))) {
      await recordFail(ip);
      return res.status(403).json({ error: 'wrong password' });
    }
    const rec = await hashPassword(b.password);
    await redis([['HSET', K_USERS, sess.name, JSON.stringify({ ...sess.u, pw: rec })], ['DEL', sess.key]]);
    await newSession(req, res, sess.name, saltOf(rec));
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
      const { users, sess } = await getState(req);
      const user = sess ? who(sess.name, sess.u) : null;
      if (!list) {
        const ready = [...users.values()].some((u) => u.pw);
        return res.status(200).json({ ready, authed: Boolean(sess), user });
      }
      if (!sess) return res.status(401).json({ error: 'unauthorized' });
      const { bottles, replies } = await readBottles();
      return res.status(200).json({
        user,
        bottles: bottles.map((x) => {
          const o = { id: x.id, t: Number(x.t) || 0, name: String(x.name || ''), text: String(x.text || '') };
          if (Object.prototype.hasOwnProperty.call(replies, x.id)) o.reply = withBy(replies[x.id], users);
          return o;
        })
      });
    }
    const raw = readBody(req);
    const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const op = Object.prototype.hasOwnProperty.call(OPS, b.op) ? OPS[b.op] : null;
    if (!op) return res.status(400).json({ error: 'bad op' });
    const st = (b.op === 'reply' || b.op === 'password') ? await getState(req) : null;
    return await op(req, res, b, st);
  } catch (e) {
    return res.status(502).json({ error: 'storage error' });
  }
};
// 給 scripts/reply-setup.js 共用，避免 key 名稱與帳號規則兩邊寫不一樣
module.exports.keys = { USERS: K_USERS, SETUP: K_SETUP };
module.exports.USER = USER;
module.exports.normUser = normUser;
