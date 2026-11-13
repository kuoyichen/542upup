// 我也想問
//   POST /api/ask-vote { vid, id, on: boolean }  → { id, votes, on }
const { configured, redis, readBody, isJson } = require('./_redis');
const { clientIp } = require('./admin');
const A = require('./_ask');

const VID = /^[a-z0-9]{6,32}$/;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(503).json({ error: 'not configured' });
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method not allowed' }); }
  if (!isJson(req)) return res.status(415).json({ error: 'unsupported media type' });
  try {
    const b = readBody(req);
    if (!VID.test(String(b.vid || '')) || typeof b.id !== 'string' || !b.id || typeof b.on !== 'boolean') {
      return res.status(400).json({ error: 'bad request' });
    }
    // 三趟往返：存在／隱藏檢查與限流計數併成一趟，再一趟 SADD|SREM + SCARD，最後寫票數快取。
    // 票數以投票者集合的大小為準（單一事實來源）；ask:vc 只是 SCARD 的快取，寫入中斷或亂序會被 readAll 定期對帳修正
    const hour = Math.floor(Date.now() / 3600e3);
    const key = A.K.VRL(clientIp(req), hour);
    const [q, hidden, n] = await redis([['HGET', A.K.Q, b.id], ['SISMEMBER', A.K.HIDDEN, b.id], ['INCR', key], ['EXPIRE', key, 7200]]);
    if (n > A.VOTE_IP_HOUR_MAX) return res.status(429).json({ error: 'busy' });
    if (!q || Number(hidden) === 1) return res.status(404).json({ error: 'not found' });
    const [, votes] = await redis([[b.on ? 'SADD' : 'SREM', A.K.VOTERS(b.id), b.vid], ['SCARD', A.K.VOTERS(b.id)]]);
    // 寫票數快取（ask:vc，readAll 讀這個）；失敗不影響投票者，快取之後由 readAll 的定期對帳修正
    try { await redis([['HSET', A.K.VC, b.id, String(Number(votes) || 0)]]); } catch (e) { /* 忽略 */ }
    // 不清公開列表快取：投票者的畫面用這個回應更新，其他人最多晚 5 秒看到
    return res.status(200).json({ id: b.id, votes: Number(votes) || 0, on: b.on });
  } catch (e) {
    return res.status(502).json({ error: 'storage error' });
  }
};
