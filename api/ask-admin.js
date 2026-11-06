// 鎮妹！給問嗎？後台（沿用 /reply 的帳號與 isl_admin cookie；路徑在 /api/admin 底下 cookie 才會帶上）
//   GET  /api/admin/ask                    → { user, open, questions（含 hidden/excluded/gone，不含 raw） }
//   POST /api/admin/ask { op, ... }        → { ok: true }
//     hide / unhide / exclude / include { id }、src { id, src }、open { which, open }
const { configured, redis, readBody } = require('./_redis');
const { getState, sameOrigin, who } = require('./admin');
const A = require('./_ask');

const SRCS = ['online', 'live'];
const strip = ({ raw, ...q }) => q;

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
    const { sess } = await getState(req);
    if (!sess) return res.status(401).json({ error: 'unauthorized' });
    const user = who(sess.name, sess.u);
    if (req.method === 'GET') {
      const { questions, open } = await A.readAll();
      return res.status(200).json({ user, open, questions: questions.map(strip) });
    }
    const raw = readBody(req);
    const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    if (b.op === 'open') {
      if (!SRCS.includes(b.which) || typeof b.open !== 'boolean') return res.status(400).json({ error: 'bad request' });
      const cmds = [['HSET', A.K.OPEN, b.which, b.open ? '1' : '0']];
      if (b.which === 'online' && !b.open) cmds.push(['HSET', A.K.OPEN, 'closedAt', String(Date.now())]);
      await redis(cmds);
      A.invalidate();
      return res.status(200).json({ ok: true });
    }
    if (!['hide', 'unhide', 'exclude', 'include', 'src'].includes(b.op)) return res.status(400).json({ error: 'bad op' });
    if (typeof b.id !== 'string' || !b.id) return res.status(400).json({ error: 'bad request' });
    if (b.op === 'src' && !SRCS.includes(b.src)) return res.status(400).json({ error: 'bad src' });
    // 讀一次：順便把島上來的瓶子補進提問列表，並取得 raw
    const q = (await A.readAll()).questions.find((x) => x.id === b.id);
    if (!q) return res.status(404).json({ error: 'not found' });
    // 沒被隱藏的題目（例如舊分頁按的恢復公開）什麼都不動：不然 LREM 再 LPUSH 會把公開的瓶子無故移到清單最前面，
    // 而且 LREM 與 LPUSH 之間剛好有讀取的話，會把它誤當成在別處被刪掉
    if (b.op === 'unhide' && !q.hidden) return res.status(200).json({ ok: true });
    const K = A.K;
    let cmds;
    if (b.op === 'hide') cmds = [['SADD', K.HIDDEN, b.id], ['SADD', K.EXCLUDED, b.id], ['LREM', K.BOTTLES, 0, q.raw]];
    // unhide：先記重放時間、把瓶子放回清單最前面，最後才移出隱藏與 gone（順序見 _ask.js readAll 的說明）
    else if (b.op === 'unhide') cmds = [['LREM', K.BOTTLES, 0, q.raw], ['HSET', K.PUSHED, b.id, String(Date.now())], ['LPUSH', K.BOTTLES, q.raw], ['LTRIM', K.BOTTLES, 0, A.KEEP - 1], ['SREM', K.HIDDEN, b.id], ['SREM', K.GONE, b.id]];
    else if (b.op === 'exclude') cmds = [['SADD', K.EXCLUDED, b.id]];
    else if (b.op === 'include') cmds = [['SREM', K.EXCLUDED, b.id]];
    else cmds = [['HSET', K.SRC, b.id, b.src]];
    await redis(cmds);
    A.invalidate();
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(502).json({ error: 'storage error' });
  }
};
