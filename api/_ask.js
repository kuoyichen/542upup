// 「鎮妹！給問嗎？」資料層：問題存 hash、瓶子照舊進 542upup:bottles（只加欄位）。
const { P, redis } = require('./_redis');
const VILLAGES = require('./_villages');

const K = {
  Q: P + 'ask:q',
  HIDDEN: P + 'ask:hidden',
  EXCLUDED: P + 'ask:excluded',
  SRC: P + 'ask:src',
  VOTES: P + 'ask:votes',
  VOTERS: (id) => P + 'ask:voters:' + id,
  OPEN: P + 'ask:open',
  RL: (vid) => P + 'ask:rl:' + vid,
  HOUR: (h) => P + 'ask:hour:' + h,
  QIP: (ip, h) => P + 'ask:qip:' + ip + ':' + h,
  VRL: (ip, h) => P + 'ask:vrl:' + ip + ':' + h,
  BOTTLES: P + 'bottles',
};
const MAX_TEXT = 120, MAX_NAME = 16, KEEP = 200, RATE_SEC = 45, HOUR_MAX = 600, VOTE_IP_HOUR_MAX = 400, CACHE_MS = 5000;
// 每 IP 每小時提問上限：活動現場的共用 Wi-Fi、手機電信 CGNAT 會讓很多人共用同一個 IP，所以抓寬一點
const ASK_IP_HOUR_MAX = 100;

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const pairs = (flat) => { const o = {}; for (let i = 0; i + 1 < (flat || []).length; i += 2) o[flat[i]] = flat[i + 1]; return o; };
const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

async function readAll() {
  const [qs, hidden, excluded, src, votes, open, bottles] = await redis([
    ['HGETALL', K.Q], ['SMEMBERS', K.HIDDEN], ['SMEMBERS', K.EXCLUDED],
    ['HGETALL', K.SRC], ['HGETALL', K.VOTES], ['HGETALL', K.OPEN],
    ['LRANGE', K.BOTTLES, 0, KEEP - 1],
  ]);
  const hid = new Set(hidden || []), exc = new Set(excluded || []);
  const srcMap = pairs(src), voteMap = pairs(votes), o = pairs(open);
  const qMap = pairs(qs);
  // 島上留言（api/bottles.js 或原 Vercel 部署寫入）補建進提問列表；只 HSETNX，不覆寫。
  const closed = o.online === '0', closedAt = Number(o.closedAt) || 0;
  const writes = [];
  for (const raw of bottles || []) {
    const b = parse(raw);
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
    if (typeof b.id !== 'string' || typeof b.text !== 'string' || !b.text) continue;
    if (b.ask || qMap[b.id]) continue;
    const t = Number(b.t) || 0;
    const rec = { id: b.id, t, text: b.text, name: b.name || '匿名鎮民', vil: '', origin: 'island', src: 'online', raw };
    const json = JSON.stringify(rec);
    writes.push(['HSETNX', K.Q, b.id, json]);
    if (closed && t > closedAt) { writes.push(['SADD', K.EXCLUDED, b.id]); exc.add(b.id); }
    qMap[b.id] = json;
  }
  if (writes.length) await redis(writes);
  const questions = Object.values(qMap).map(parse).filter(Boolean).map((q) => ({
    id: q.id, t: q.t, text: q.text, name: q.name, vil: q.vil,
    origin: q.origin || 'ask',
    src: srcMap[q.id] || q.src || 'online',
    votes: Number(voteMap[q.id]) || 0,
    hidden: hid.has(q.id),
    excluded: exc.has(q.id),
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
    questions: questions.filter((q) => !q.hidden).map(({ id, t, text, name, vil, origin, src, votes }) => ({ id, t, text, name, vil, origin, src, votes })),
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

async function addQuestion({ text, name, vil, src }) {
  const id = newId(), t = Date.now();
  const raw = JSON.stringify({ id, t, text, name, vil, ask: 1 });
  const origin = 'ask';
  const stored = { id, t, text, name, vil, origin, src, raw };
  await redis([
    ['HSET', K.Q, id, JSON.stringify(stored)],
    ['LPUSH', K.BOTTLES, raw],
    ['LTRIM', K.BOTTLES, 0, KEEP - 1],
  ]);
  return { id, t, text, name, vil, origin, src, votes: 0, hidden: false, excluded: false, raw };
}

module.exports = { K, MAX_TEXT, MAX_NAME, KEEP, RATE_SEC, HOUR_MAX, VOTE_IP_HOUR_MAX, ASK_IP_HOUR_MAX, CACHE_MS, VILLAGES, newId, readAll, readPublic, invalidate, addQuestion };
