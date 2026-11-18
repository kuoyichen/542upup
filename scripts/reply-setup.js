// 建立 /reply 後台帳號、產生一次性「設定密碼」連結（7 天有效，用過即失效）
//   node scripts/reply-setup.js --user smalt --name 小編     建立帳號（還沒有密碼）並產生連結
//   node scripts/reply-setup.js --user smalt --reset         既有帳號重發連結：舊連結立即失效，目前的密碼在新連結用掉前照常可用
//   --base https://island.542upup.tw                         連結網址前綴
//   --out 檔案路徑                                           連結寫到哪裡（預設 repo 根目錄 .reply-setup-links.txt，一個帳號一行）
// 連結只寫進權限 0600 的檔案，重跑某個帳號只換掉那一行；終端機不印 token。
// 資料庫連線同 server.js：讀 .env，已存在的環境變數優先。每次執行都會清掉舊版單一密碼留下的 542upup:reply:setup。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch (e) { /* 無 .env */ }
const { P, configured, redis } = require('../api/_redis');
const { keys: K, USER, normUser } = require('../api/admin');

const TTL = 7 * 86400;
const K_LEGACY_SETUP = P + 'reply:setup';
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim();

function args(argv) {
  const o = { user: '', name: undefined, reset: false, base: 'https://island.542upup.tw', out: path.join(ROOT, '.reply-setup-links.txt') };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = argv[i].includes('=') ? argv[i].split(/=(.*)/s) : [argv[i], undefined];
    const val = () => (v !== undefined ? v : argv[++i]);
    if (k === '--reset') o.reset = true;
    else if (k === '--user') o.user = normUser(val());
    else if (k === '--name') o.name = cleanName(val());
    else if (k === '--base') o.base = val();
    else if (k === '--out') o.out = path.resolve(val() || '');
    else throw new Error('不認得的參數：' + k);
  }
  if (!USER.test(o.user)) throw new Error('--user 需要 2 到 32 個英文小寫、數字或底線');
  if (o.reset && o.name !== undefined) throw new Error('--reset 不改顯示名稱，請拿掉 --name');
  if (!o.reset && (!o.name || o.name.length > 20)) throw new Error('建立帳號需要 --name（顯示名稱，1 到 20 個字）');
  let u;
  try { u = new URL(o.base); } catch (e) { throw new Error('--base 不是有效網址'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('--base 必須是 http 或 https');
  o.base = u.origin + u.pathname.replace(/\/+$/, '');
  return o;
}

// 一個帳號一行「帳號 連結」；只換掉這個帳號那一行
function writeLink(file, user, link) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch (e) { /* 第一次寫 */ }
  lines = lines.filter((l) => l.trim() && !l.startsWith(user + ' '));
  lines.push(user + ' ' + link);
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600); // 檔案原本就存在時 writeFileSync 不會改權限
}

async function main() {
  const o = args(process.argv.slice(2));
  if (!configured()) throw new Error('找不到資料庫連線設定（KV_REST_API_URL / KV_REST_API_TOKEN）');
  const [raw] = await redis([['HGET', K.USERS, o.user]]);
  if (raw && !o.reset) throw new Error(`帳號已存在：${o.user}。要重發設定連結請加 --reset`);
  if (!raw && o.reset) throw new Error(`找不到帳號：${o.user}`);
  let display = o.name;
  if (o.reset) { try { display = JSON.parse(raw).display || o.user; } catch (e) { display = o.user; } }
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const cmds = [['DEL', K_LEGACY_SETUP]];
  if (!o.reset) cmds.push(['HSET', K.USERS, o.user, JSON.stringify({ display, pw: '', t: Date.now() })]);
  cmds.push(['SET', K.SETUP + o.user, hash, 'EX', TTL]); // 覆蓋＝這個帳號之前沒用掉的連結立即失效
  await redis(cmds);
  writeLink(o.out, o.user, o.base + '/reply#setup=' + token + '&user=' + o.user);
  const exp = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(Date.now() + TTL * 1000));
  console.log(o.reset
    ? `已為 ${o.user}（${display}）重發設定連結；之前的連結已失效，目前的密碼在新連結用掉前照常可用。`
    : `已建立帳號 ${o.user}（${display}），還沒有密碼。`);
  console.log('設定連結已寫入：' + o.out + '（' + o.user + ' 那一行）');
  console.log('有效期限：' + exp + '（台灣時間），用過一次即失效。');
}

main().catch((e) => {
  console.error('失敗：' + (e && e.message));
  process.exitCode = 1;
});
