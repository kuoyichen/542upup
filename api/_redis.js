// Upstash Redis REST 小工具（不需額外套件），旅人足跡與留言瓶共用。
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

const P = '542upup:';
const configured = () => Boolean(URL_ && TOKEN);
const envNames = () => Object.keys(env).filter((n) => /REDIS|KV|UPSTASH/.test(n)).sort();

async function redis(cmds) {
  const r = await fetch(URL_.replace(/\/+$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map((x) => { if (x.error) throw new Error(x.error); return x.result; });
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
}

// 公開寫入 API 只收 application/json：text/plain 等「簡單請求」不會觸發 CORS 預檢，
// 第三方網頁能讓訪客的瀏覽器代為送出；要求 JSON 就逼它先預檢（預檢會被擋）。
const isJson = (req) => String((req.headers && req.headers['content-type']) || '').split(';')[0].trim().toLowerCase() === 'application/json';

module.exports = { P, configured, envNames, redis, readBody, isJson };
