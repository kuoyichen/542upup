// 本機開發用的假 bot「今天的政策島捕捉」（只放記憶體），讓政策島頁面不必連正式 bot 就能測 /api/catch-today
//   node dev/fake-catch-today.js [--port 48792] [--island I08] [--mode active] [--expires-in 3600]
//   --mode：active（預設，回分身資料）、inactive（{"active":false}）、error（回 500）、
//           slow（延遲 8 秒才回，用來測 5 秒逾時）、badjson（回 200 但不是 JSON）
//   --expires-in：active 時 expires_at 設為「現在起幾秒後」，預設 3600
// 再用 CATCH_TODAY_URL=http://127.0.0.1:48792/api/catch/today node server.js 啟動網站（可搭 dev/fake-upstash.js）。
// 執行中改設定：GET /set?island=I03&mode=active（也可帶 expires_in=秒），回目前設定；不用重啟就能把 12 座島逐一試過。
//   例：for n in 01 02 03 04 05 06 07 08 09 10 11 12; do curl -s "127.0.0.1:48792/set?island=I$n"; done
// 注意：網站有 60 秒快取，改完設定要等快取過期（或重啟網站）頁面才會看到新的島。
// claim_url 是假的測試網址 https://liff.line.me/TESTLIFF/catch?c=FAKE-<島>，點了不會領到任何點數。
// 只聽 127.0.0.1，不連任何外部服務。
const http = require('http');

const MODES = ['active', 'inactive', 'error', 'slow', 'badjson'];
const ISLAND = /^I(0[1-9]|1[0-2])$/;
const SLOW_MS = 8e3;

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};

const state = {
  island: arg('island', 'I08'),
  mode: arg('mode', 'active'),
  expiresIn: Number(arg('expires-in', 3600))
};
if (!ISLAND.test(state.island)) { console.error('--island 要是 I01 到 I12'); process.exit(1); }
if (!MODES.includes(state.mode)) { console.error('--mode 要是 ' + MODES.join(' / ')); process.exit(1); }
if (!(state.expiresIn > 0)) { console.error('--expires-in 要是正數（秒）'); process.exit(1); }

// 台北日期 YYYY-MM-DD
const taipeiDate = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);

function body() {
  const t = Date.now();
  return {
    active: true,
    date: taipeiDate(t),
    island: state.island,
    claim_url: `https://liff.line.me/TESTLIFF/catch?c=FAKE-${state.island}`,
    expires_at: new Date(t + state.expiresIn * 1e3).toISOString()
  };
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/set') {
    const island = u.searchParams.get('island'), mode = u.searchParams.get('mode'), exp = u.searchParams.get('expires_in');
    if (island !== null && !ISLAND.test(island)) return json(res, 400, { error: 'island 要是 I01 到 I12' });
    if (mode !== null && !MODES.includes(mode)) return json(res, 400, { error: 'mode 要是 ' + MODES.join(' / ') });
    if (exp !== null && !(Number(exp) > 0)) return json(res, 400, { error: 'expires_in 要是正數（秒）' });
    if (island !== null) state.island = island;
    if (mode !== null) state.mode = mode;
    if (exp !== null) state.expiresIn = Number(exp);
    console.log('set', JSON.stringify(state));
    return json(res, 200, state);
  }
  if (u.pathname !== '/api/catch/today') return json(res, 404, { error: 'not found' });
  console.log(new Date().toISOString(), 'GET /api/catch/today', state.mode, state.island);
  if (state.mode === 'error') return json(res, 500, { error: 'fake error' });
  if (state.mode === 'badjson') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"active": tru'); }
  if (state.mode === 'inactive') return json(res, 200, { active: false });
  if (state.mode === 'slow') return setTimeout(() => json(res, 200, body()), SLOW_MS);
  return json(res, 200, body());
});

server.listen(Number(arg('port', 48792)), '127.0.0.1', () => {
  console.log('fake catch/today on http://127.0.0.1:' + server.address().port + '/api/catch/today ' + JSON.stringify(state));
});
