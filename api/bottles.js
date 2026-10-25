// 留言瓶：訪客留言變成漂在海上的瓶子
//   GET  /api/bottles                     最新 30 則（新到舊）
//   POST /api/bottles { vid, text, name }  丟一個瓶子：每位訪客 45 秒限一則、全站每小時最多 120 則
// 只保留最新 200 則。要刪除不當留言：Upstash Console 對清單 542upup:bottles 用 LREM。
const { P, configured, redis, readBody } = require('./_redis');

const KEY = P + 'bottles';
const KEEP = 200, SHOW = 30;
const MAX_TEXT = 120, MAX_NAME = 16;
const VID = /^[a-z0-9]{6,32}$/;
// 基本過濾：擋網址與常見髒話，其餘由管理者從 Upstash 後台刪除
const BLOCK = [/https?:\/\//i, /www\./i, /幹你|幹妳|操你|靠北|機掰|雞掰|白癡|智障|去死|fuck|shit|bitch/i];
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(503).json({ error: 'not configured' });
  try {
    if (req.method === 'GET') {
      const [list] = await redis([['LRANGE', KEY, 0, SHOW - 1]]);
      const bottles = (list || []).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
      return res.status(200).json({ bottles });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method not allowed' }); }
    const b = readBody(req);
    if (!VID.test(String(b.vid || ''))) return res.status(400).json({ error: 'bad request' });
    const text = clean(b.text, MAX_TEXT), name = clean(b.name, MAX_NAME) || '匿名鎮民';
    if (text.length < 2) return res.status(400).json({ error: 'too short' });
    if (BLOCK.some((r) => r.test(text) || r.test(name))) return res.status(400).json({ error: 'blocked' });
    const hour = Math.floor(Date.now() / 3600e3);
    const [ok, n] = await redis([
      ['SET', P + 'bottle:rl:' + b.vid, '1', 'NX', 'EX', 45],
      ['INCR', P + 'bottle:hour:' + hour],
      ['EXPIRE', P + 'bottle:hour:' + hour, 7200]
    ]);
    if (ok !== 'OK') return res.status(429).json({ error: 'slow down' });
    if (n > 120) return res.status(429).json({ error: 'busy' });
    const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), t: Date.now(), text, name };
    await redis([['LPUSH', KEY, JSON.stringify(item)], ['LTRIM', KEY, 0, KEEP - 1]]);
    return res.status(201).json({ bottle: item });
  } catch (e) {
    return res.status(502).json({ error: 'storage error' });
  }
};
