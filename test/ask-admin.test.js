// 鎮妹！給問嗎？後台 API：/api/admin/ask。全程接本機假 Upstash。
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { start, adminCookie } = require('./helpers/server-env.js');
// _redis.js 在 require 時讀環境變數，所以 _ask.js 要等 start() 之後才載入
let A, env, cookie, n = 0, vil;
const ADMIN = '/api/admin/ask';
const P = '542upup:';
const ask = (text, extra = {}) => env.call('POST', '/api/ask', { body: { vid: 'vid' + (++n) + 'abcdef', text, name: 'T', vil, ...extra } });
const adm = (body, headers = {}) => env.call('POST', ADMIN, { headers: { cookie, ...headers }, body });
const pub = async () => (await env.call('GET', '/api/ask')).body;
const adminList = async () => (await env.call('GET', ADMIN, { headers: { cookie } })).body;
const inPub = async (id) => (await pub()).questions.some((q) => q.id === id);
const inAdmin = async (id) => (await adminList()).questions.find((q) => q.id === id);
const bottleRaws = () => env.store('LRANGE', A.K.BOTTLES, 0, -1);
const excluded = () => env.store('SMEMBERS', A.K.EXCLUDED);

before(async () => {
  env = await start();
  A = require('../api/_ask.js');
  vil = A.VILLAGES[0];
  cookie = await adminCookie(env, 'smalt');
});
after(async () => { await env.stop(); });

describe('/api/admin/ask', () => {
  describe('守門', () => {
    it('無 cookie GET／POST 都 401', async () => {
      assert.equal((await env.call('GET', ADMIN)).status, 401);
      assert.equal((await env.call('POST', ADMIN, { body: { op: 'hide', id: 'x' } })).status, 401);
    });
    it('跨站 Origin 403、非 JSON 415', async () => {
      assert.equal((await adm({ op: 'hide', id: 'x' }, { origin: 'http://evil.example' })).status, 403);
      assert.equal((await adm('op=hide', { 'content-type': 'text/plain' })).status, 415);
    });
    it('未知 op 400、id 不存在 404、GET 不含 raw', async () => {
      assert.equal((await adm({ op: 'nope' })).status, 400);
      assert.equal((await adm({ op: 'hide', id: 'nonexistent' })).status, 404);
      const q = (await ask('GET 不含 raw 的測試題')).body.question;
      const l = (await env.call('GET', ADMIN, { headers: { cookie } })).body;
      assert.equal(l.user.name, 'smalt');
      assert.ok(l.open && typeof l.open.online === 'boolean');
      const got = l.questions.find((x) => x.id === q.id);
      assert.ok(got && !('raw' in got));
    });
  });

  describe('hide / unhide', () => {
    it('活動頁提問 hide：公開列表立即不含、瓶子清單不含、excluded 含、admin hidden', async () => {
      const q = (await ask('要被隱藏的活動頁問題')).body.question;
      assert.ok(await inPub(q.id));
      assert.equal((await adm({ op: 'hide', id: q.id })).status, 200);
      assert.ok(!(await inPub(q.id)));
      assert.ok(!(await bottleRaws()).some((r) => r.includes(q.id)));
      assert.ok((await excluded()).includes(q.id));
      assert.equal((await inAdmin(q.id)).hidden, true);
    });
    it('島上瓶子 hide：LRANGE 不含原字串，且不因同步回來', async () => {
      const raw = JSON.stringify({ id: 'isl1', t: Date.now(), name: '島民', text: '島上來的留言一則' });
      env.store('LPUSH', A.K.BOTTLES, raw);
      assert.ok(await inAdmin('isl1')); // 後台 GET 不走快取，觸發島上瓶子同步
      assert.equal((await adm({ op: 'hide', id: 'isl1' })).status, 200);
      assert.ok(!(await bottleRaws()).includes(raw));
      assert.ok(!(await inPub('isl1')));
      assert.ok(!(await bottleRaws()).includes(raw));
    });
    it('unhide：公開又看得到、bottles 恰好一則、excluded 仍含', async () => {
      const q = (await ask('隱藏再取消隱藏的問題')).body.question;
      await adm({ op: 'hide', id: q.id });
      assert.equal((await adm({ op: 'unhide', id: q.id })).status, 200);
      assert.ok(await inPub(q.id));
      assert.equal((await bottleRaws()).filter((r) => r.includes(q.id)).length, 1);
      assert.ok((await excluded()).includes(q.id));
      // 沒隱藏過直接 unhide 也不會重複
      await adm({ op: 'unhide', id: q.id });
      assert.equal((await bottleRaws()).filter((r) => r.includes(q.id)).length, 1);
    });
  });

  describe('隱藏與 /reply 的回覆', () => {
    const replyList = () => env.call('GET', '/api/admin?list=1', { headers: { cookie } });
    it('隱藏有回覆的島上瓶子後打開 /reply 列表，回覆仍在；恢復公開後照常顯示', async () => {
      const id = 'islreply01';
      env.store('LPUSH', A.K.BOTTLES, JSON.stringify({ id, t: Date.now(), name: '島民', text: '島上留言等媛婷回覆' }));
      const rp = await env.call('POST', '/api/admin', { headers: { cookie }, body: { op: 'reply', id, text: '媛婷的回覆' } });
      assert.equal(rp.status, 200);
      assert.equal((await adm({ op: 'hide', id })).status, 200);
      const l = await replyList();
      assert.equal(l.status, 200);
      assert.ok(!l.body.bottles.some((b) => b.id === id));
      assert.ok(env.store('HGET', '542upup:replies', id), '隱藏的島上瓶子的回覆被當孤兒刪掉');
      assert.equal((await adm({ op: 'unhide', id })).status, 200);
      const l2 = await replyList();
      const b = l2.body.bottles.find((x) => x.id === id);
      assert.ok(b && b.reply && b.reply.text === '媛婷的回覆');
      // 公開 /api/replies 照舊：瓶子在清單裡才給
      assert.equal((await env.call('GET', '/api/replies')).body.replies[id].text, '媛婷的回覆');
    });
  });

  describe('在別處被刪掉的瓶子', () => {
    // 只清活動頁與瓶子的 key，保留 /reply 的帳號與 session
    beforeEach(() => {
      for (const k of [...env.fake.store.data.keys()]) if (k.startsWith('542upup:ask:') || k === A.K.BOTTLES) env.fake.store.data.delete(k);
      A.invalidate();
    });
    const fill = (n, t0) => env.store('LPUSH', A.K.BOTTLES, ...Array.from({ length: n }, (_, i) => JSON.stringify({ id: 'f' + String(i).padStart(4, '0'), t: t0 + i, text: '島上瓶子', name: 'a' })));
    const rawOf = (id, t) => JSON.stringify({ id, t, text: '題目 ' + id, name: 'a' });
    const rec = (id, t) => JSON.stringify({ id, t, text: '題目 ' + id, name: 'a', vil: '', origin: 'island', src: 'online', raw: rawOf(id, t) });

    it('GET 標 gone；恢復公開清掉 gone、瓶子放回清單恰好一則', async () => {
      // 清單裡要有一則夠舊的瓶子當基準（刪最舊的偵測不到，見 _ask.js 的已知缺口）
      env.store('LPUSH', A.K.BOTTLES, JSON.stringify({ id: 'anchor1', t: Date.now() - 300000, text: '基準', name: 'a' }));
      const q = (await ask('會在別處被刪掉的題目')).body.question;
      const raw = bottleRaws().find((r) => r.includes(q.id));
      env.store('LREM', A.K.BOTTLES, 0, raw);
      const got = await inAdmin(q.id);
      assert.deepEqual([got.hidden, got.excluded, got.gone], [true, true, true]);
      assert.ok(!(await inPub(q.id)));
      assert.equal((await adm({ op: 'unhide', id: q.id })).status, 200);
      assert.ok(!env.store('SMEMBERS', P + 'ask:gone').includes(q.id));
      const back = await inAdmin(q.id);
      assert.deepEqual([back.hidden, back.gone], [false, false]);
      assert.equal(bottleRaws().filter((r) => r === raw).length, 1);
      assert.ok(await inPub(q.id));
    });
    it('清單滿過之後在後台隱藏一則（清單剩 199），自然擠出的舊題不會被當成刪除', async () => {
      env.store('HSET', A.K.Q, 'old0001', rec('old0001', 5000));
      fill(200, 10000);
      assert.ok(await inAdmin('f0100'));
      assert.equal((await adm({ op: 'hide', id: 'f0100' })).status, 200);
      assert.equal(bottleRaws().length, 199);
      const old = await inAdmin('old0001');
      assert.deepEqual([old.hidden, old.gone], [false, false]);
      assert.deepEqual(env.store('SMEMBERS', P + 'ask:gone'), []);
    });
    it('恢復公開把舊題的瓶子放回清單最前面，不會讓比它新、已被擠出的題目被當成刪除', async () => {
      fill(200, 10000);
      // old0001 早就被隱藏（瓶子已拿掉）；mid0001 比它新，但早已被擠出 200 則
      env.store('HSET', A.K.Q, 'old0001', rec('old0001', 5000), 'mid0001', rec('mid0001', 8000));
      env.store('SADD', A.K.HIDDEN, 'old0001');
      assert.equal((await adm({ op: 'unhide', id: 'old0001' })).status, 200);
      assert.equal(bottleRaws()[0], rawOf('old0001', 5000));
      for (const id of ['mid0001', 'f0000', 'old0001']) {
        const q = await inAdmin(id);
        assert.deepEqual([q.hidden, q.gone], [false, false], id);
      }
      assert.deepEqual(env.store('SMEMBERS', P + 'ask:gone'), []);
    });
    it('恢復公開一則沒被隱藏的題目（舊分頁）什麼都不動：瓶子清單順序、hidden／excluded／gone、重放時間都不變', async () => {
      fill(200, 10000);
      env.store('SADD', A.K.GONE, 'gone0001');
      assert.ok(await inAdmin('f0150')); // 先同步一次，之後的讀取不再寫入
      assert.equal((await adm({ op: 'hide', id: 'f0100' })).status, 200);
      assert.equal((await adm({ op: 'exclude', id: 'f0050' })).status, 200);
      const snap = () => ({
        bottles: bottleRaws(),
        hidden: env.store('SMEMBERS', A.K.HIDDEN).sort(),
        excluded: env.store('SMEMBERS', A.K.EXCLUDED).sort(),
        gone: env.store('SMEMBERS', A.K.GONE).sort(),
        pushed: env.store('HGETALL', A.K.PUSHED),
      });
      const before = snap();
      assert.equal(before.bottles.length, 199);
      assert.deepEqual(before.hidden, ['f0100']);
      assert.equal((await adm({ op: 'unhide', id: 'f0150' })).status, 200);
      assert.deepEqual(snap(), before);
      assert.equal((await inAdmin('f0150')).hidden, false);
    });
  });

  describe('exclude / include / src', () => {
    it('include 後 excluded 不含；exclude 後含', async () => {
      const q = (await ask('排除與納入的問題')).body.question;
      assert.equal((await adm({ op: 'exclude', id: q.id })).status, 200);
      assert.ok((await excluded()).includes(q.id));
      assert.equal((await adm({ op: 'include', id: q.id })).status, 200);
      assert.ok(!(await excluded()).includes(q.id));
    });
    it('src live：admin 與公開都是 live；src x 400', async () => {
      const q = (await ask('改來源的問題')).body.question;
      assert.equal((await adm({ op: 'src', id: q.id, src: 'live' })).status, 200);
      assert.equal((await inAdmin(q.id)).src, 'live');
      assert.equal((await pub()).questions.find((x) => x.id === q.id).src, 'live');
      assert.equal((await adm({ op: 'src', id: q.id, src: 'x' })).status, 400);
    });
  });

  describe('已抽出、已回答、影片', () => {
    const mk = async (t) => (await ask(t)).body.question;
    const drawnSet = () => env.store('SMEMBERS', A.K.DRAWN);
    it('draw：200、admin drawn、公開無 drawn；再 draw 409；putback 後可再 draw', async () => {
      const q = await mk('要被抽出的問題');
      assert.equal((await adm({ op: 'draw', id: q.id })).status, 200);
      assert.equal((await inAdmin(q.id)).drawn, true);
      const p = (await pub()).questions.find((x) => x.id === q.id);
      assert.ok(p && !('drawn' in p));
      const r = await adm({ op: 'draw', id: q.id });
      assert.deepEqual([r.status, r.body], [409, { error: 'unavailable' }]);
      assert.equal((await adm({ op: 'putback', id: q.id })).status, 200);
      assert.equal((await inAdmin(q.id)).drawn, false);
      assert.equal((await adm({ op: 'draw', id: q.id })).status, 200);
    });
    it('隱藏、排除、已回答的題目 draw → 409 unavailable', async () => {
      const a = await mk('隱藏的不可抽'), b = await mk('排除的不可抽'), c = await mk('已回答的不可抽');
      await adm({ op: 'hide', id: a.id });
      await adm({ op: 'exclude', id: b.id });
      await adm({ op: 'answer', id: c.id, on: true });
      for (const q of [a, b, c]) {
        const r = await adm({ op: 'draw', id: q.id });
        assert.deepEqual([r.status, r.body], [409, { error: 'unavailable' }], q.id);
      }
    });
    it('draw 競態：readAll 快照可抽、之後才被隱藏 → 409，且不留在 ask:drawn', async () => {
      const q = await mk('快照後被隱藏');
      const orig = A.readAll;
      A.readAll = async () => {
        const snap = await orig();
        env.store('SADD', P + 'ask:hidden', q.id); // 後台在快照與 SADD drawn 之間隱藏
        return snap;
      };
      let r;
      try { r = await adm({ op: 'draw', id: q.id }); } finally { A.readAll = orig; }
      assert.deepEqual([r.status, r.body], [409, { error: 'unavailable' }]);
      assert.ok(!drawnSet().includes(q.id));
    });
    it('exclude 與 hide 會清掉 drawn', async () => {
      const a = await mk('抽出後排除'), b = await mk('抽出後隱藏');
      await adm({ op: 'draw', id: a.id });
      await adm({ op: 'draw', id: b.id });
      await adm({ op: 'exclude', id: a.id });
      await adm({ op: 'hide', id: b.id });
      assert.ok(!drawnSet().includes(a.id) && !drawnSet().includes(b.id));
    });
    it('answer on：answered、drawn 清掉、公開仍列出且 answered；off：answered false、video 清空', async () => {
      const q = await mk('回答流程的問題');
      await adm({ op: 'draw', id: q.id });
      assert.equal((await adm({ op: 'answer', id: q.id, on: true })).status, 200);
      const a = await inAdmin(q.id);
      assert.deepEqual([a.answered, a.drawn], [true, false]);
      assert.equal((await pub()).questions.find((x) => x.id === q.id).answered, true);
      await adm({ op: 'video', id: q.id, url: 'https://youtu.be/abc' });
      assert.equal((await adm({ op: 'answer', id: q.id, on: false })).status, 200);
      const o = await inAdmin(q.id);
      assert.deepEqual([o.answered, o.video], [false, '']);
      assert.equal((await pub()).questions.find((x) => x.id === q.id).video, '');
      assert.equal((await adm({ op: 'answer', id: q.id, on: 'yes' })).status, 400);
    });
    it('video：未回答 409；壞網址 400；合法 https 在 admin 與公開；空字串清空', async () => {
      const q = await mk('影片網址的問題');
      const r0 = await adm({ op: 'video', id: q.id, url: 'https://youtu.be/abc' });
      assert.deepEqual([r0.status, r0.body], [409, { error: 'not answered' }]);
      await adm({ op: 'answer', id: q.id, on: true });
      for (const url of ['javascript:alert(1)', 'http://x', 'https://' + 'a'.repeat(293), 'https://a b', 5]) {
        const r = await adm({ op: 'video', id: q.id, url });
        assert.deepEqual([r.status, r.body], [400, { error: 'bad url' }], String(url).slice(0, 20));
      }
      const ok = 'https://youtu.be/abc?t=1';
      assert.equal((await adm({ op: 'video', id: q.id, url: ok })).status, 200);
      assert.equal((await inAdmin(q.id)).video, ok);
      assert.equal((await pub()).questions.find((x) => x.id === q.id).video, ok);
      assert.equal((await adm({ op: 'video', id: q.id, url: '' })).status, 200);
      assert.equal((await inAdmin(q.id)).video, '');
    });
    describe('影片寫進媛婷回覆', () => {
      const FIXED = '這題在「鎮妹！給問嗎？」活動中回答了，點下面看影片。';
      const URL1 = 'https://youtu.be/xyz?t=2';
      const rep = (id) => { const s = env.store('HGET', A.K.REPLIES, id); return s ? JSON.parse(s) : null; };
      const pubReply = async (id) => (await env.call('GET', '/api/replies')).body.replies[id];
      const answered = async (t) => { const q = await mk(t); await adm({ op: 'answer', id: q.id, on: true }); return q; };
      const manual = (id, text) => env.call('POST', '/api/admin', { headers: { cookie }, body: { op: 'reply', id, text } });
      it('沒有回覆：貼影片建立固定文字回覆（by 為操作帳號），公開有 url 沒有 by', async () => {
        const q = await answered('沒回覆的題目要附影片');
        assert.equal((await adm({ op: 'video', id: q.id, url: URL1 })).status, 200);
        const r = rep(q.id);
        assert.equal(r.text, FIXED);
        assert.equal(r.url, URL1);
        assert.equal(r.by, 'smalt');
        assert.ok(Math.abs(r.t - Date.now()) < 5000);
        const p = await pubReply(q.id);
        assert.equal(p.url, URL1);
        assert.equal(p.text, FIXED);
        assert.ok(!('by' in p));
      });
      it('已有人工回覆：貼影片只加 url，text／t／by 不變；清掉影片還原', async () => {
        const q = await answered('已有人工回覆的題目');
        assert.equal((await manual(q.id, '媛婷親手寫的回覆')).status, 200);
        const before = rep(q.id);
        assert.equal((await adm({ op: 'video', id: q.id, url: URL1 })).status, 200);
        assert.deepEqual(rep(q.id), { ...before, url: URL1 });
        assert.equal((await adm({ op: 'video', id: q.id, url: '' })).status, 200);
        assert.deepEqual(rep(q.id), before);
      });
      it('貼影片後 /reply 改字：文字更新、url 保留，公開 /api/replies 仍有 url', async () => {
        const q = await answered('改字不能掉影片');
        await manual(q.id, '第一版回覆');
        await adm({ op: 'video', id: q.id, url: URL1 });
        assert.equal((await manual(q.id, '改過的回覆')).status, 200);
        const r = rep(q.id);
        assert.equal(r.text, '改過的回覆');
        assert.equal(r.url, URL1);
        const p = await pubReply(q.id);
        assert.deepEqual([p.text, p.url], ['改過的回覆', URL1]);
      });
      it('清掉影片：固定文字回覆整則刪除', async () => {
        const q = await answered('固定文字回覆要被刪');
        await adm({ op: 'video', id: q.id, url: URL1 });
        assert.equal((await adm({ op: 'video', id: q.id, url: '' })).status, 200);
        assert.equal(rep(q.id), null);
      });
      it('沒有回覆時清影片不動；answer off 同樣清掉影片（固定文字刪、人工回覆留文字）', async () => {
        const a = await answered('沒回覆清影片');
        assert.equal((await adm({ op: 'video', id: a.id, url: '' })).status, 200);
        assert.equal(rep(a.id), null);
        const b = await answered('answer off 刪固定文字');
        await adm({ op: 'video', id: b.id, url: URL1 });
        assert.equal((await adm({ op: 'answer', id: b.id, on: false })).status, 200);
        assert.equal(rep(b.id), null);
        const c = await answered('answer off 留人工文字');
        await manual(c.id, '人工寫的');
        await adm({ op: 'video', id: c.id, url: URL1 });
        await adm({ op: 'answer', id: c.id, on: false });
        assert.equal(rep(c.id).text, '人工寫的');
        assert.ok(!('url' in rep(c.id)));
      });
    });
    it('公開資料不含 drawn／raw／hidden／excluded／gone', async () => {
      const q = await mk('公開欄位白名單');
      const p = (await pub()).questions.find((x) => x.id === q.id);
      for (const k of ['drawn', 'raw', 'hidden', 'excluded', 'gone']) assert.ok(!(k in p), k);
      assert.deepEqual([p.answered, p.video], [false, '']);
    });
  });

  describe('open', () => {
    it('online 關閉寫 closedAt，線上提問 403；重開後 201', async () => {
      assert.equal((await adm({ op: 'open', which: 'online', open: false })).status, 200);
      assert.ok(Number.isFinite(Number(env.store('HGET', A.K.OPEN, 'closedAt'))) && Number(env.store('HGET', A.K.OPEN, 'closedAt')) > 0);
      assert.equal((await ask('關閉後線上提問')).status, 403);
      assert.equal((await adm({ op: 'open', which: 'online', open: true })).status, 200);
      assert.equal((await ask('重開後線上提問')).status, 201);
    });
    it('which 不合法 400', async () => {
      assert.equal((await adm({ op: 'open', which: 'x', open: true })).status, 400);
      assert.equal((await adm({ op: 'open', which: 'live', open: 'yes' })).status, 400);
    });
  });
});
