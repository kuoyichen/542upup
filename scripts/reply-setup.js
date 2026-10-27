// 產生 /reply 後台的一次性「設定密碼」連結（7 天有效，用過即失效）
//   node scripts/reply-setup.js                 尚未設定密碼時產生連結
//   node scripts/reply-setup.js --reset         清掉現有密碼（所有已登入裝置一併登出）再產生連結
//   --base https://island.542upup.tw            連結網址前綴
//   --out 檔案路徑                              連結寫到哪裡（預設 repo 根目錄 .reply-setup-link.txt）
// 連結只寫進權限 0600 的檔案，終端機不印 token。資料庫連線同 server.js：讀 .env，已存在的環境變數優先。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch (e) { /* 無 .env */ }
const { P, configured, redis } = require('../api/_redis');

const TTL = 7 * 86400;
const K_PW = P + 'reply:pw', K_SETUP = P + 'reply:setup';

function args(argv) {
  const o = { reset: false, base: 'https://island.542upup.tw', out: path.join(ROOT, '.reply-setup-link.txt') };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = argv[i].includes('=') ? argv[i].split(/=(.*)/s) : [argv[i], undefined];
    const val = () => (v !== undefined ? v : argv[++i]);
    if (k === '--reset') o.reset = true;
    else if (k === '--base') o.base = val();
    else if (k === '--out') o.out = path.resolve(val() || '');
    else throw new Error('不認得的參數：' + k);
  }
  let u;
  try { u = new URL(o.base); } catch (e) { throw new Error('--base 不是有效網址'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('--base 必須是 http 或 https');
  o.base = u.origin + u.pathname.replace(/\/+$/, '');
  return o;
}

async function main() {
  const o = args(process.argv.slice(2));
  if (!configured()) throw new Error('找不到資料庫連線設定（KV_REST_API_URL / KV_REST_API_TOKEN）');
  const [pw] = await redis([['GET', K_PW]]);
  if (pw && !o.reset) {
    console.error('密碼已經設定過了。要重設請加 --reset（所有已登入的裝置都會被登出）。');
    process.exitCode = 1;
    return;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const cmds = [];
  if (o.reset) cmds.push(['DEL', K_PW]);
  cmds.push(['SET', K_SETUP, hash, 'EX', TTL]);
  await redis(cmds);
  fs.writeFileSync(o.out, o.base + '/reply#setup=' + token + '\n', { mode: 0o600 });
  fs.chmodSync(o.out, 0o600); // 檔案原本就存在時 writeFileSync 不會改權限
  const exp = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(Date.now() + TTL * 1000));
  if (o.reset) console.log('已清除舊密碼，所有已登入的裝置都已登出。');
  console.log('設定連結已寫入：' + o.out);
  console.log('有效期限：' + exp + '（台灣時間），用過一次即失效。');
}

main().catch((e) => {
  console.error('失敗：' + (e && e.message));
  process.exitCode = 1;
});
