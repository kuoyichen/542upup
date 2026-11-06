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
  VRL: (ip, h) => P + 'ask:vrl:' + ip + ':' + h,
  BOTTLES: P + 'bottles',
};
const MAX_TEXT = 120, MAX_NAME = 16, KEEP = 200, RATE_SEC = 45, HOUR_MAX = 600, VOTE_IP_HOUR_MAX = 400, CACHE_MS = 5000;

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const pairs = (flat) => { const o = {}; for (let i = 0; i + 1 < (flat || []).length; i += 2) o[flat[i]] = flat[i + 1]; return o; };
const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

async function readAll() {
  const [qs, hidden, excluded, src, votes, open] = await redis([
    ['HGETALL', K.Q], ['SMEMBERS', K.HIDDEN], ['SMEMBERS', K.EXCLUDED],
    ['HGETALL', K.SRC], ['HGETALL', K.VOTES], ['HGETALL', K.OPEN],
  ]);
  const hid = new Set(hidden || []), exc = new Set(excluded || []);
  const srcMap = pairs(src), voteMap = pairs(votes), o = pairs(open);
  const questions = Object.values(pairs(qs)).map(parse).filter(Boolean).map((q) => ({
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

let cache = null;
const invalidate = () => { cache = null; };

async function readPublic() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.v;
  const { questions, open } = await readAll();
  const v = {
    open: { online: open.online, live: open.live },
    questions: questions.filter((q) => !q.hidden).map(({ id, t, text, name, vil, origin, src, votes }) => ({ id, t, text, name, vil, origin, src, votes })),
  };
  cache = { at: Date.now(), v };
  return v;
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

module.exports = { K, MAX_TEXT, MAX_NAME, KEEP, RATE_SEC, HOUR_MAX, VOTE_IP_HOUR_MAX, CACHE_MS, VILLAGES, newId, readAll, readPublic, invalidate, addQuestion };
