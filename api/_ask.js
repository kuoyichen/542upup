// 「鎮妹！給問嗎？」資料層：問題存 hash、瓶子照舊進 542upup:bottles（只加欄位）。
const { P, redis } = require('./_redis');
const VILLAGES = require('./_villages');

const K = {
  Q: P + 'ask:q',
  HIDDEN: P + 'ask:hidden',
  EXCLUDED: P + 'ask:excluded',
  SRC: P + 'ask:src',
  VOTES: P + 'ask:votes',      // 已不再寫入也不再讀取（票數改以 VOTERS 集合大小為準）；舊資料留在 Upstash 無害
  VOTERS: (id) => P + 'ask:voters:' + id,
  UNHIDE_LOCK: (id) => P + 'ask:lock:unhide:' + id, // 恢復公開的短鎖（NX EX 10），避免並行恢復把瓶子放回兩次
  OPEN: P + 'ask:open',
  RL: (vid) => P + 'ask:rl:' + vid,
  HOUR: (h) => P + 'ask:hour:' + h,
  QIP: (ip, h) => P + 'ask:qip:' + ip + ':' + h,
  VRL: (ip, h) => P + 'ask:vrl:' + ip + ':' + h,
  ANSWERED: P + 'ask:answered', // set
  DRAWN: P + 'ask:drawn',       // set：已抽出、還沒處理
  VIDEO: P + 'ask:video',       // hash id → https 網址
  REPLIES: P + 'replies',       // 既有 hash，瓶子 id → JSON {text,t,by,url?}
  GONE: P + 'ask:gone',        // set：瓶子在別處（Upstash Console、原作者 Vercel 版）被刪掉而自動隱藏的題目
  PUSHED: P + 'ask:pushed',    // hash id → 後台「恢復公開」把瓶子重新放回清單的毫秒
  FULL: P + 'ask:full',        // 已不再寫入也不再讀取（偵測改用保守的時間規則）；舊資料留在 Upstash 無害
  BOTTLES: P + 'bottles',
};
const MAX_TEXT = 120, MAX_NAME = 16, KEEP = 200, RATE_SEC = 45, HOUR_MAX = 600, VOTE_IP_HOUR_MAX = 1000, CACHE_MS = 5000, VIDEO_MAX = 300;
// 每 IP 每小時提問上限：活動現場的共用 Wi-Fi、手機電信 CGNAT 會讓很多人共用同一個 IP，所以抓寬一點
const ASK_IP_HOUR_MAX = 100;
// 判斷「自然擠出還是被刪」的寬限：瓶子的 t 是各寫入端在送出前自己取的（addQuestion、Zeabur 與原作者 Vercel 上的
// bottles.js、恢復公開的重放時間），隔著一趟網路來回、兩台主機時鐘也不同，t 的大小不一定等於進清單的先後。
// 先推、t 卻稍大的瓶子被擠出時，比清單裡最早那則新一點點，沒有寬限就會被誤當成刪除並永久隱藏。
const TRIM_SLACK_MS = 60000;

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const pairs = (flat) => { const o = {}; for (let i = 0; i + 1 < (flat || []).length; i += 2) o[flat[i]] = flat[i + 1]; return o; };
const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

async function readAll() {
  // 指令順序有講究：Upstash 的 pipeline 不是原子操作，可能和提問、後台的寫入交錯。
  // 提問 hash 在瓶子清單之前讀、隱藏名單在清單前後各讀一次、重放時間在清單之後讀；
  // 搭配 addQuestion（先 LPUSH 再 HSET）、hide（先 SADD 再 LREM）、unhide（先記重放時間與 LPUSH，最後才 SREM）
  // 的寫入順序，交錯時也不會把題目誤判成「在別處被刪掉」。
  const [qs, hidden, excluded, src, open, gone, bottles, pushed, hidden2, answered, drawn, video] = await redis([
    ['HGETALL', K.Q], ['SMEMBERS', K.HIDDEN], ['SMEMBERS', K.EXCLUDED],
    ['HGETALL', K.SRC], ['HGETALL', K.OPEN], ['SMEMBERS', K.GONE],
    ['LRANGE', K.BOTTLES, 0, KEEP - 1],
    ['HGETALL', K.PUSHED], ['SMEMBERS', K.HIDDEN],
    ['SMEMBERS', K.ANSWERED], ['SMEMBERS', K.DRAWN], ['HGETALL', K.VIDEO],
  ]);
  const hid = new Set(hidden || []), exc = new Set(excluded || []), gon = new Set(gone || []), hid2 = new Set(hidden2 || []);
  const srcMap = pairs(src), o = pairs(open), pushedAt = pairs(pushed);
  const qMap = pairs(qs);
  const ans = new Set(answered || []), drw = new Set(drawn || []), videoMap = pairs(video);
  // 島上留言（api/bottles.js 或原 Vercel 部署寫入）補建進提問列表；只 HSETNX，不覆寫。
  const closed = o.online === '0', closedAt = Number(o.closedAt) || 0;
  const writes = [];
  const listed = new Set();
  let oldest = Infinity;
  for (const raw of bottles || []) {
    const b = parse(raw);
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
    if (typeof b.id === 'string') {
      listed.add(b.id);
      // 進清單的時間：後台「恢復公開」重新放回的舊瓶子用重放時間，不然它的舊 t 會讓比它新、已擠出的題目被當成刪除
      const at = Math.max(Number(b.t) || 0, Number(pushedAt[b.id]) || 0);
      if (at > 0 && at < oldest) oldest = at;
    }
    if (typeof b.id !== 'string' || typeof b.text !== 'string' || !b.text) continue;
    if (b.ask || qMap[b.id]) continue;
    const t = Number(b.t) || 0;
    const rec = { id: b.id, t, text: b.text, name: b.name || '匿名鎮民', vil: '', origin: 'island', src: 'online', raw };
    const json = JSON.stringify(rec);
    writes.push(['HSETNX', K.Q, b.id, json]);
    if (closed && t > closedAt) { writes.push(['SADD', K.EXCLUDED, b.id]); exc.add(b.id); }
    qMap[b.id] = json;
  }
  // 在別處被刪掉的瓶子（Upstash Console LREM、原作者的 Vercel 版）：沒隱藏、瓶子卻不在清單裡的題目當成隱藏。
  // 保守規則：只有「比清單裡最早進來那則還新、超過 TRIM_SLACK_MS」的題目才算被刪（它不可能是被擠出的）；
  // 其餘不在清單的舊題無法分辨是自然擠出還是被刪，一律不動（維持公開，後台可手動隱藏）。
  // 不再記「清單滿過」：島上的寫入端（api/bottles.js、原作者 Vercel 版）推入後 LTRIM 並不會留下紀錄，靠不住。
  // 已知缺口：被刪的剛好是清單裡最舊的那幾則時偵測不到。清單裡沒有任何有效時間（oldest 為 Infinity）則什麼都不偵測。
  // 已隱藏的跳過（瓶子是我們自己拿掉的）。
  for (const [id, json] of Object.entries(qMap)) {
    if (listed.has(id) || hid.has(id) || hid2.has(id)) continue;
    const q = parse(json);
    if (!q || !(Number(q.t) > oldest + TRIM_SLACK_MS)) continue;
    writes.push(['SADD', K.HIDDEN, id], ['SADD', K.EXCLUDED, id], ['SADD', K.GONE, id]);
    hid.add(id); exc.add(id); gon.add(id);
  }
  if (writes.length) await redis(writes);
  // 票數：每題投票者集合的大小（含剛補建的島上題目）；沒有題目就不送
  const ids = Object.keys(qMap), voteMap = {};
  if (ids.length) (await redis(ids.map((id) => ['SCARD', K.VOTERS(id)]))).forEach((c, i) => { voteMap[ids[i]] = Number(c) || 0; });
  const questions = Object.values(qMap).map(parse).filter(Boolean).map((q) => ({
    id: q.id, t: q.t, text: q.text, name: q.name, vil: q.vil,
    origin: q.origin || 'ask',
    src: srcMap[q.id] || q.src || 'online',
    votes: Number(voteMap[q.id]) || 0,
    hidden: hid.has(q.id),
    excluded: exc.has(q.id),
    gone: gon.has(q.id),
    answered: ans.has(q.id),
    drawn: drw.has(q.id),
    video: videoMap[q.id] || '',
    raw: q.raw,
  })).sort((a, b) => b.t - a.t);
  return { questions, open: { online: o.online !== '0', live: o.live !== '0', closedAt: Number(o.closedAt) || 0 } };
}

// 公開列表快取 5 秒。gen：invalidate() 之前開始的讀取不得寫回快取（否則剛隱藏的題目會被舊結果帶回來）；
// inflight：快取失效時同時進來的請求共用同一次 readAll，invalidate() 會丟掉它，下一個請求重新讀。
let cache = null, gen = 0, inflight = null;
const invalidate = () => { cache = null; gen++; inflight = null; };

async function loadPublic(g) {
  const { questions, open } = await readAll();
  const v = {
    open: { online: open.online, live: open.live },
    questions: questions.filter((q) => !q.hidden).map(({ id, t, text, name, vil, origin, src, votes, answered, video }) => ({ id, t, text, name, vil, origin, src, votes, answered, video: answered ? video : '' })),
  };
  if (g === gen) cache = { at: Date.now(), v };
  return v;
}

async function readPublic() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.v;
  if (!inflight) {
    const p = loadPublic(gen).finally(() => { if (inflight === p) inflight = null; });
    inflight = p;
  }
  return inflight;
}

// 回覆同步：把影片網址寫進 /reply 的回覆（hash K.REPLIES，id → JSON {text,t,by,url?}）。url 空字串＝清掉。by＝後台帳號名
const REPLY_TEXT = '這題在「鎮妹！給問嗎？」活動中回答了，點下面看影片。';
// 注意：HGET→HSET 與同時進行的 /reply 存檔不是原子操作（已接受，機率低）
async function syncReply(id, url, by) {
  const [raw] = await redis([['HGET', K.REPLIES, id]]);
  let cur = null;
  try { cur = raw ? JSON.parse(raw) : null; } catch (e) { cur = null; }
  if (cur && (typeof cur !== 'object' || typeof cur.text !== 'string')) cur = null;
  if (url) {
    const next = cur ? { ...cur, url } : { text: REPLY_TEXT, t: Date.now(), by, url };
    await redis([['HSET', K.REPLIES, id, JSON.stringify(next)]]);
    return;
  }
  if (!cur) return;
  if (cur.text === REPLY_TEXT) { await redis([['HDEL', K.REPLIES, id]]); return; }
  if ('url' in cur) {
    const { url: _drop, ...rest } = cur;
    await redis([['HSET', K.REPLIES, id, JSON.stringify(rest)]]);
  }
}

async function addQuestion({ text, name, vil, src }) {
  const id = newId(), t = Date.now();
  const raw = JSON.stringify({ id, t, text, name, vil, ask: 1 });
  const origin = 'ask';
  const stored = { id, t, text, name, vil, origin, src, raw };
  // 先放瓶子再寫提問 hash：和 readAll 交錯時不會出現「題目在、瓶子還沒進清單」而被當成刪除
  await redis([
    ['LPUSH', K.BOTTLES, raw],
    ['LTRIM', K.BOTTLES, 0, KEEP - 1],
    ['HSET', K.Q, id, JSON.stringify(stored)],
  ]);
  return { id, t, text, name, vil, origin, src, votes: 0, hidden: false, excluded: false, answered: false, drawn: false, video: '', raw };
}

module.exports = { K, MAX_TEXT, MAX_NAME, KEEP, RATE_SEC, HOUR_MAX, VOTE_IP_HOUR_MAX, VIDEO_MAX, ASK_IP_HOUR_MAX, CACHE_MS, VILLAGES, newId, readAll, readPublic, invalidate, addQuestion, syncReply, REPLY_TEXT };
