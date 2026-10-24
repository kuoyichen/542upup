// 旅人足跡：網站訪問記錄（Vercel Serverless Function）
// POST {t:'view', v:訪客代號} 記一次瀏覽；POST {t:'dwell', s:秒數} 累加停留時間；GET 回傳統計。
// 資料存在 Upstash Redis（Vercel Storage → Upstash for Redis），只存累計數字，不存 IP 或個資。

// 接上資料庫時，環境變數可能帶自訂前綴（例如 STORAGE_KV_REST_API_URL），或只有 rediss:// 連線字串
const env = process.env;
const pick = (re) => { const k = Object.keys(env).find((n) => re.test(n) && env[n]); return k ? env[k] : ''; };
let URL_ = pick(/(KV_REST_API_URL|REDIS_REST_URL)$/);
let TOKEN = pick(/(KV_REST_API_TOKEN|REDIS_REST_TOKEN)$/);
if (!URL_ || !TOKEN) {
  // Upstash 的 rediss://default:密碼@主機:6379 也可換成 REST：https://主機 ＋ 密碼當 token
  const m = /^rediss?:\/\/[^:]*:([^@]+)@([^:/]+\.upstash\.io)/.exec(pick(/(REDIS_URL|KV_URL)$/));
  if (m) { URL_ = 'https://' + m[2]; TOKEN = decodeURIComponent(m[1]); }
}
const envNames = () => Object.keys(env).filter((n) => /REDIS|KV|UPSTASH/.test(n)).sort();
const P = '542upup:';
const DAYS = 14;
const MAX_DWELL = 2 * 3600;

async function redis(cmds) {
  const r = await fetch(URL_ + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map((x) => x.result);
}

// 台灣時間的日期 YYYY-MM-DD
const day = (offset = 0) => new Date(Date.now() + 8 * 3600e3 - offset * 86400e3).toISOString().slice(0, 10);

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(200).json({ configured: false, env: envNames() });
  try {
    if (req.method === 'POST') {
      const b = readBody(req);
      const d = day();
      if (b.t === 'view') {
        const cmds = [['INCR', P + 'views'], ['INCR', P + 'views:' + d]];
        if (typeof b.v === 'string' && /^[a-z0-9]{6,32}$/.test(b.v)) cmds.push(['PFADD', P + 'visitors', b.v]);
        await redis(cmds);
      } else if (b.t === 'dwell') {
        const s = Math.round(Number(b.s));
        if (s > 0 && s <= MAX_DWELL) await redis([['INCRBY', P + 'dwell', s], ['INCRBY', P + 'dwell:' + d, s]]);
      }
      return res.status(204).end();
    }
    const days = Array.from({ length: DAYS }, (_, i) => day(DAYS - 1 - i));
    const out = await redis([
      ['GET', P + 'views'], ['GET', P + 'dwell'], ['PFCOUNT', P + 'visitors'],
      ['MGET', ...days.map((d) => P + 'views:' + d)],
      ['MGET', ...days.map((d) => P + 'dwell:' + d)]
    ]);
    const n = (x) => Number(x) || 0;
    return res.status(200).json({
      configured: true,
      views: n(out[0]), dwell: n(out[1]), visitors: n(out[2]),
      days: days.map((d, i) => ({ d, views: n(out[3][i]), dwell: n(out[4][i]) }))
    });
  } catch (e) {
    return res.status(502).json({ configured: true, error: 'storage' });
  }
};
