// 鎮妹！給問嗎？後台（沿用 /reply 的帳號與 isl_admin cookie；路徑在 /api/admin 底下 cookie 才會帶上）
//   GET  /api/admin/ask                    → { user, open, questions（含 hidden/excluded/gone，不含 raw） }
//   POST /api/admin/ask { op, ... }        → { ok: true }
//     hide / unhide / exclude / include / draw / putback { id }、src { id, src }、answer { id, on }、video { id, url }、open { which, open }
const crypto = require('crypto');
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
    if (!['hide', 'unhide', 'exclude', 'include', 'src', 'draw', 'putback', 'answer', 'video'].includes(b.op)) return res.status(400).json({ error: 'bad op' });
    if (typeof b.id !== 'string' || !b.id) return res.status(400).json({ error: 'bad request' });
    if (b.op === 'src' && !SRCS.includes(b.src)) return res.status(400).json({ error: 'bad src' });
    if (b.op === 'answer' && typeof b.on !== 'boolean') return res.status(400).json({ error: 'bad request' });
    // 每題一把短鎖（NX EX 10）：後台操作從讀取、寫入、抽選驗證到回覆同步全程持有，
    // 兩個後台同時改同一題時後到的拿不到鎖就回 busy，不會交錯出「公開但島上沒瓶子」或「沒回答卻有影片」
    const K = A.K;
    const lockKey = K.LOCK(b.id);
    const token = crypto.randomBytes(12).toString('hex');
    const [got] = await redis([['SET', lockKey, token, 'NX', 'EX', 10]]);
    if (got !== 'OK') return res.status(409).json({ error: b.op === 'draw' ? 'unavailable' : 'busy' });
    // 回應先算好、放鎖之後才送出，呼叫端收到回應時鎖一定已釋放
    let out;
    try {
    out = await (async () => {
    // 讀一次：順便把島上來的瓶子補進提問列表，並取得 raw
    const q = (await A.readAll()).questions.find((x) => x.id === b.id);
    if (!q) return [404, { error: 'not found' }];
    // 沒被隱藏的題目（例如舊分頁按的恢復公開）什麼都不動：不然 LREM 再 LPUSH 會把公開的瓶子無故移到清單最前面，
    // 而且 LREM 與 LPUSH 之間剛好有讀取的話，會把它誤當成在別處被刪掉
    if (b.op === 'unhide' && !q.hidden) return [200, { ok: true }];
    let cmds;
    if (b.op === 'hide') cmds = [['SADD', K.HIDDEN, b.id], ['SADD', K.EXCLUDED, b.id], ['SREM', K.DRAWN, b.id], ['LREM', K.BOTTLES, 0, q.raw]];
    // unhide：先記重放時間、把瓶子放回清單最前面，最後才移出隱藏與 gone（順序見 _ask.js readAll 的說明）
    else if (b.op === 'unhide') cmds = [['LREM', K.BOTTLES, 0, q.raw], ['HSET', K.PUSHED, b.id, String(Date.now())], ['LPUSH', K.BOTTLES, q.raw], ['LTRIM', K.BOTTLES, 0, A.KEEP - 1], ['SREM', K.HIDDEN, b.id], ['SREM', K.GONE, b.id]];
    else if (b.op === 'exclude') cmds = [['SADD', K.EXCLUDED, b.id], ['SREM', K.DRAWN, b.id]];
    else if (b.op === 'include') cmds = [['SREM', K.EXCLUDED, b.id]];
    else if (b.op === 'putback') cmds = [['SREM', K.DRAWN, b.id]];
    else if (b.op === 'answer') cmds = b.on ? [['SADD', K.ANSWERED, b.id], ['SREM', K.DRAWN, b.id]] : [['SREM', K.ANSWERED, b.id], ['HDEL', K.VIDEO, b.id]];
    else if (b.op === 'draw') {
      if (q.hidden || q.excluded || q.answered) return [409, { error: 'unavailable' }];
      const [added] = await redis([['SADD', K.DRAWN, b.id]]);
      A.invalidate();
      if (!Number(added)) return [409, { error: 'unavailable' }];
      // 先認領再驗證：readAll 快照之後、SADD 之前若有後台隱藏／排除／標已回答（或瓶子被刪），這裡才擋得住；
      // 驗證之後才發生的隱藏等同「隱藏一則已抽出的題目」，hide 本來就會清掉 drawn，可接受
      const [h, x, a, e] = await redis([['SISMEMBER', K.HIDDEN, b.id], ['SISMEMBER', K.EXCLUDED, b.id], ['SISMEMBER', K.ANSWERED, b.id], ['HEXISTS', K.Q, b.id]]);
      if (Number(h) || Number(x) || Number(a) || !Number(e)) {
        await redis([['SREM', K.DRAWN, b.id]]);
        A.invalidate();
        return [409, { error: 'unavailable' }];
      }
      return [200, { ok: true }];
    } else if (b.op === 'video') {
      if (!q.answered) return [409, { error: 'not answered' }];
      if (typeof b.url !== 'string' || (b.url !== '' && (b.url.length > A.VIDEO_MAX || !/^https:\/\/\S+$/.test(b.url)))) return [400, { error: 'bad url' }];
      cmds = b.url === '' ? [['HDEL', K.VIDEO, b.id]] : [['HSET', K.VIDEO, b.id, b.url]];
    } else cmds = [['HSET', K.SRC, b.id, b.src]];
    await redis(cmds);
    A.invalidate();
    // 狀態已寫入，回覆同步失敗不能讓整個操作變 502：記 log、回 200 並帶 replyError 讓後台頁提醒（同步也在鎖內）
    let replyError = false;
    try {
      if (b.op === 'video') await A.syncReply(b.id, b.url, user.name);
      else if (b.op === 'answer' && !b.on) await A.syncReply(b.id, '', user.name);
    } catch (e) {
      replyError = true;
      console.error('syncReply failed', b.op, b.id, e && e.message);
    }
    return [200, replyError ? { ok: true, replyError: true } : { ok: true }];
    })();
    } finally {
      // 只刪自己的鎖：鎖若已過期並被別人重拿，值不同就不動；放鎖失敗由 EX 10 兜底
      try { const [cur] = await redis([['GET', lockKey]]); if (cur === token) await redis([['DEL', lockKey]]); } catch (e) { /* 鎖會自己過期 */ }
    }
    return res.status(out[0]).json(out[1]);
  } catch (e) {
    return res.status(502).json({ error: 'storage error' });
  }
};
