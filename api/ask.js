// 鎮妹！給問嗎？
//   GET  /api/ask   公開問題列表、里名、收題開關
//   POST /api/ask { vid, text, name, vil, live? }  提問
const { P, configured, redis, readBody } = require('./_redis');
const { BLOCK, clean } = require('./bottles');
const { clientIp } = require('./admin');
const A = require('./_ask');

const VID = /^[a-z0-9]{6,32}$/;
const strip = ({ raw, hidden, excluded, ...q }) => q;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(503).json({ error: 'not configured' });
  try {
    if (req.method === 'GET') {
      const { open, questions } = await A.readPublic();
      return res.status(200).json({ questions, villages: A.VILLAGES, open });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method not allowed' }); }
    const b = readBody(req);
    if (!VID.test(String(b.vid || ''))) return res.status(400).json({ error: 'bad request' });
    const text = clean(b.text, A.MAX_TEXT), name = clean(b.name, A.MAX_NAME) || '匿名鎮民';
    if (text.length < 2) return res.status(400).json({ error: 'too short' });
    if (BLOCK.some((r) => r.test(text) || r.test(name))) return res.status(400).json({ error: 'blocked' });
    const vil = String(b.vil || '');
    if (!A.VILLAGES.includes(vil)) return res.status(400).json({ error: 'bad village' });
    const src = b.live ? 'live' : 'online';
    const [open] = await redis([['HGETALL', A.K.OPEN]]);
    const idx = (open || []).indexOf(src);
    if (idx >= 0 && idx % 2 === 0 && open[idx + 1] === '0') return res.status(403).json({ error: 'closed' });
    // 依序檢查，前一關擋下就不碰後面的計數：同一 vid 45 秒一則 → 每 IP 每小時 → 全站每小時
    // （否則一個人狂送就能把全站每小時額度用完）
    const [ok] = await redis([['SET', A.K.RL(b.vid), '1', 'NX', 'EX', A.RATE_SEC]]);
    if (ok !== 'OK') return res.status(429).json({ error: 'slow down' });
    const hour = Math.floor(Date.now() / 3600e3);
    const ipKey = A.K.QIP(clientIp(req), hour);
    const [ni] = await redis([['INCR', ipKey], ['EXPIRE', ipKey, 7200]]);
    if (ni > A.ASK_IP_HOUR_MAX) return res.status(429).json({ error: 'busy' });
    const [n] = await redis([['INCR', A.K.HOUR(hour)], ['EXPIRE', A.K.HOUR(hour), 7200]]);
    if (n > A.HOUR_MAX) return res.status(429).json({ error: 'busy' });
    const q = await A.addQuestion({ text, name, vil, src });
    A.invalidate();
    return res.status(201).json({ question: strip(q) });
  } catch (e) {
    return res.status(502).json({ error: 'storage error' });
  }
};
