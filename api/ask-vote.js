// 我也想問
//   POST /api/ask-vote { vid, id, on: boolean }  → { id, votes, on }
const { configured, redis, readBody } = require('./_redis');
const A = require('./_ask');

const VID = /^[a-z0-9]{6,32}$/;
const first = (v) => String(v || '').split(',')[0].trim();
const clientIp = (req) => {
  const raw = first(req.headers['x-forwarded-for']) || (req.socket && req.socket.remoteAddress) || '';
  return raw.toLowerCase().replace(/[^0-9a-f:.]/g, '').slice(0, 45) || 'unknown';
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(503).json({ error: 'not configured' });
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method not allowed' }); }
  try {
    const b = readBody(req);
    if (!VID.test(String(b.vid || '')) || typeof b.id !== 'string' || !b.id || typeof b.on !== 'boolean') {
      return res.status(400).json({ error: 'bad request' });
    }
    const [q, hidden] = await redis([['HGET', A.K.Q, b.id], ['SISMEMBER', A.K.HIDDEN, b.id]]);
    if (!q || Number(hidden) === 1) return res.status(404).json({ error: 'not found' });
    const hour = Math.floor(Date.now() / 3600e3);
    const key = A.K.VRL(clientIp(req), hour);
    const [n] = await redis([['INCR', key], ['EXPIRE', key, 7200]]);
    if (n > A.VOTE_IP_HOUR_MAX) return res.status(429).json({ error: 'busy' });
    const [changed] = await redis([[b.on ? 'SADD' : 'SREM', A.K.VOTERS(b.id), b.vid]]);
    if (Number(changed) === 1) await redis([['HINCRBY', A.K.VOTES, b.id, b.on ? 1 : -1]]);
    const [cur] = await redis([['HGET', A.K.VOTES, b.id]]);
    let votes = Math.max(0, Number(cur) || 0);
    if ((Number(cur) || 0) < 0) { await redis([['HSET', A.K.VOTES, b.id, 0]]); votes = 0; }
    A.invalidate();
    return res.status(200).json({ id: b.id, votes, on: b.on });
  } catch (e) {
    return res.status(502).json({ error: 'storage error' });
  }
};
