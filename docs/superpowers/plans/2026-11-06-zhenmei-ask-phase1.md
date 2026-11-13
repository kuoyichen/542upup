# 鎮妹！給問嗎？第一段（收題上線）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 上線 `ask.542upup.tw` 收題：鎮民頁提問與「我也想問」、島上留言雙向同步、後台隱藏／排除／收題開關、島上「鎮妹給問」標籤。

**Architecture:** 在政策島同一個零依賴 Node server 加三支 API（`api/ask.js` 公開、`api/ask-vote.js` 投票、`api/ask-admin.js` 後台），共用資料層 `api/_ask.js`；資料放同一個 Upstash，前綴 `542upup:ask:`，狀態用 Set／Hash 分開存以免互相覆蓋。`server.js` 依 Host 分流，`ask.` 開頭的網域對應兩個新頁 `ask.html`、`ask-admin.html`。島上 `index.html` 只加標籤。

**Tech Stack:** Node ≥20.12（無套件）、Upstash Redis REST pipeline、原生 HTML/CSS/JS、`node --test`。

**Spec:** `docs/superpowers/specs/2026-11-06-zhenmei-ask-design.md`（第 11 節第一段）。雛形：https://claude.ai/artifact/Udxf66upqjYDHZ7fw7KqGM

## Global Constraints

- 只在 `zeabur` 分支開發與 commit，**不推 main**；`git push`、Zeabur 部署、DNS 都要使用者當場確認。
- 測試與本機開發絕不碰正式 Upstash：照 `test/reply.test.js` 的 `before()` 先刪掉所有 `(KV|REDIS|UPSTASH)` 環境變數、指向 `dev/fake-upstash.js`，再 `require('../server.js')`，並檢查沒有正式連線設定混入。本機起 server 一律接假 Upstash。
- 零依賴：不新增 npm 套件。
- `542upup:bottles` 每則格式只能「加欄位」，不改既有欄位（原作者 Vercel 版共用）。
- 問題上限 120 字、暱稱 16 字、空暱稱顯示「匿名鎮民」；過濾規則與 `api/bottles.js` 相同（同一份 `BLOCK` 與 `clean`）。
- 隱藏＝從公開列表與 `542upup:bottles` 一起拿掉，並同時排除抽選；取消隱藏不清排除。
- 線上收題關閉後，晚於關閉時間才丟的島上瓶子預設排除；「我也想問」關閉後照常可按。
- UI 文字繁體中文；中文裡的半形標點後面要接空格；不用 emoji 或裝飾性 unicode 符號。
- 樣式沿用島上 token：`--coral:#db6a41`、`--ink:#211d1d`、`--cream:#fff8f4`、`--yellow:#fcea8b`、`--teal:#3e7c8c`，字體 `"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif`；版面照雛形。
- 既有測試全過：`npm test`。

## Review Focus

1. 已隱藏的題目從任何公開出口外流（`GET /api/ask` 的 5 秒快取、投票回應），隱藏後下一次讀取就必須看不到。Task 5 有測試。
2. `LREM` 用的原字串跟清單裡的不完全相同，島上瓶子默默沒被拿掉。島上來的與活動頁來的兩種都要驗。Task 5 有測試。
3. 活動現場很多人共用同一個 Wi-Fi IP：不同裝置在同一 IP 投票都要算。網路層上限要寬（每 IP 每小時 400 票）。Task 4 有測試。
4. 共用清單裡有 Vercel 版或舊版寫進來的怪資料（不是 JSON、沒有 `name`、沒有 `t`、`id` 不是字串）：同步要略過壞的、補預設值，不能讓整個列表 502。Task 3 有測試。
5. 收題關閉的時間點：關閉前丟、關閉後才同步的島上瓶子不能被誤排除；重新開放後新丟的恢復預設進抽選庫。Task 3 有測試。

---

## 檔案結構

| 檔案 | 責任 |
|---|---|
| `api/_villages.js`（新） | 草屯鎮正式里名清單（不含「外地鄉親」，使用者 11-06 決定） |
| `api/_ask.js`（新） | key 名、常數、讀全部（含島上同步）、新增提問、公開欄位轉換、快取 |
| `api/ask.js`（新） | `GET /api/ask` 公開列表、`POST /api/ask` 提問 |
| `api/ask-vote.js`（新） | `POST /api/ask-vote` 我也想問 |
| `api/ask-admin.js`（新） | `GET/POST /api/admin/ask` 後台（路徑在 `/api/admin` 底下，才收得到 `isl_admin` cookie，它的 Path 是 `/api/admin`） |
| `api/bottles.js`（改） | 匯出 `BLOCK`、`clean` 供共用 |
| `api/admin.js`（改） | 匯出 `getState`、`sameOrigin`、`who` |
| `server.js`（改） | 新路由；依 Host 分流頁面 |
| `ask.html`、`ask-admin.html`（新） | 鎮民頁、後台 |
| `index.html`（改） | 活動瓶子的標籤與連結 |
| `dev/fake-upstash.js`（改） | 補 `SADD SREM SMEMBERS HSETNX HINCRBY LREM` |
| `test/helpers/server-env.js`（新） | 共用測試環境：假 Upstash＋server＋登入 |
| `test/ask.test.js`、`test/ask-admin.test.js`、`test/ask-pages.test.js`（新） | 測試 |

## 資料 key（全部在 `_ask.js` 的 `K`）

```js
const K = {
  Q: P + 'ask:q',              // hash id → JSON {id,t,text,name,vil,origin,src,raw}，寫一次（HSETNX）
  HIDDEN: P + 'ask:hidden',    // set
  EXCLUDED: P + 'ask:excluded',// set
  SRC: P + 'ask:src',          // hash id → 'online'|'live'（後台改過才有）
  VOTES: P + 'ask:votes',      // hash id → 次數
  VOTERS: (id) => P + 'ask:voters:' + id, // set of vid
  OPEN: P + 'ask:open',        // hash online '1'|'0'、live '1'|'0'、closedAt 毫秒；沒有欄位＝開放
  RL: (vid) => P + 'ask:rl:' + vid,        // 每 vid 45 秒
  HOUR: (h) => P + 'ask:hour:' + h,        // 全站每小時提問數
  VRL: (ip, h) => P + 'ask:vrl:' + ip + ':' + h, // 每 IP 每小時投票數
  BOTTLES: P + 'bottles',
};
```

`raw` 是那則瓶子在 `542upup:bottles` 裡的原字串，`LREM` 用。

---

### Task 1: 正式里名清單

**Files:**
- Create: `api/_villages.js`
- Test: `test/ask.test.js`（本 task 先建檔，只放里名測試）

**Interfaces:**
- Produces: `module.exports = VILLAGES`（`string[]`，27 個正式里名依官方順序；11-06 起不含「外地鄉親」）

- [ ] **Step 1: 取得官方里名。** 來源以南投縣草屯鎮公所或內政部村里資料為準；也可用中選會 111 年「南投縣草屯鎮里長選舉」各選區公報（eebulletin.cec.gov.tw）彙整。不要憑記憶補，每一個里名都要對得上來源。把來源網址寫在檔案開頭註解。
- [ ] **Step 2: 寫測試** `test/ask.test.js`：`describe('里名清單')`，斷言清單筆數＝官方里數 27（數字寫死在測試裡，註明來源）、無重複、每一項都以「里」結尾、不含「外地鄉親」。
- [ ] **Step 3: 跑** `node --test test/ask.test.js`，預期 FAIL（找不到模組）。
- [ ] **Step 4: 建** `api/_villages.js`。
- [ ] **Step 5: 跑** 同上，預期 PASS。
- [ ] **Step 6: Commit** `git add api/_villages.js test/ask.test.js && git commit -m "feat(ask): 草屯鎮里名清單" -- api/_villages.js test/ask.test.js`

交付時把完整清單與來源貼給使用者核對。

---

### Task 2: 資料層與提問 API

**Files:**
- Create: `api/_ask.js`、`api/ask.js`、`test/helpers/server-env.js`
- Modify: `api/bottles.js`（檔尾加 `module.exports.BLOCK = BLOCK; module.exports.clean = clean;`）、`dev/fake-upstash.js`（`CMDS` 補指令）、`server.js`（`ROUTES` 加 `'/api/ask'`）
- Test: `test/ask.test.js`

**Interfaces:**
- Consumes: `VILLAGES`（Task 1）；`{ BLOCK, clean }` from `./bottles`；`{ P, configured, redis, readBody }` from `./_redis`
- Produces（`api/_ask.js`）:
  - `K`（上表）、常數 `MAX_TEXT=120`、`MAX_NAME=16`、`KEEP=200`、`RATE_SEC=45`、`HOUR_MAX=600`、`VOTE_IP_HOUR_MAX=400`、`CACHE_MS=5000`
  - `newId(): string`（同 bottles.js：`Date.now().toString(36) + 4 碼亂數`）
  - `async readAll(): { questions: Question[], open: { online: boolean, live: boolean, closedAt: number } }`，新到舊。`Question = { id, t, text, name, vil, origin: 'ask'|'island', src: 'online'|'live', votes: number, hidden: boolean, excluded: boolean, raw: string }`。Task 3 會在裡面加島上同步。
  - `async readPublic(): { open: { online, live }, questions: PublicQuestion[] }`（不外露 `closedAt`），排除 hidden，有 `CACHE_MS` 記憶體快取。`PublicQuestion = { id, t, text, name, vil, origin, src, votes }`
  - `invalidate(): void` 清快取
  - `async addQuestion({ text, name, vil, src }): Question`：一個 pipeline 內 `HSET K.Q`、`LPUSH K.BOTTLES raw`、`LTRIM 0 KEEP-1`；瓶子 JSON 為 `{ id, t, text, name, vil, ask: 1 }`
- Produces（`test/helpers/server-env.js`）: `async start(): { fake, call(method, path, { headers, body }), store(cmd, ...args), stop() }`；`async adminCookie(env, name): string`（Task 5 用，照 `test/reply.test.js` 的 reply-setup → setup → login 流程拿 `isl_admin=...`）

`fake-upstash.js` 要補：`SADD`（回新增數）、`SREM`（回移除數）、`SMEMBERS`、`SISMEMBER`（回 1／0）、`HSETNX`（回 1／0）、`HINCRBY`（回新值，非整數報錯）、`LREM key 0 value`（回移除數，只需支援 count=0）。

- [ ] **Step 1: 寫失敗測試**（`test/ask.test.js` 的 `describe('提問 API')`，每個 `it` 前 `store('FLUSHALL')` 並 `invalidate`）：
  - `POST /api/ask {vid:'abcdef1',text:'市場附近什麼時候有停車場？',name:'阿明',vil:VILLAGES[0]}` → 201，`body.question` 有 `id/t/text/name/vil`、`origin==='ask'`、`src==='online'`、`votes===0`，沒有 `raw`；`store('LRANGE',P+'bottles',0,-1).map(JSON.parse)[0]` 的 `ask===1`、`vil===VILLAGES[0]`、`id` 相同。
  - 隨後 `GET /api/ask` → 200，`questions[0].id` 相同；`villages` 等於 `VILLAGES`；`open` 等於 `{online:true,live:true}`；回應 `Cache-Control: no-store`。
  - 空暱稱 → `name==='匿名鎮民'`；暱稱 20 字 → 存 16 字。
  - `vil:'不存在里'` → 400 `{error:'bad village'}`；`text:'停'` → 400 `too short`；含 `https://x.y` → 400 `blocked`；`vid:'!!'` → 400 `bad request`。
  - 同 vid 連送兩題 → 第二題 429 `slow down`。
  - `store('SET', P+'ask:hour:'+Math.floor(Date.now()/3600e3), '600')` 後送 → 429 `busy`。
  - `store('HSET',P+'ask:open','online','0')` 後線上送 → 403 `closed`；同時 `live:true` → 201 且 `src==='live'`；再 `HSET live 0` → `live:true` 也 403。
  - `GET` 不回 hidden：`store('SADD',P+'ask:hidden',id)` 加 `invalidate()` 後 GET 不含該 id。
- [ ] **Step 2: 跑** `node --test test/ask.test.js`，預期 FAIL（`/api/ask` 404）。
- [ ] **Step 3: 實作** `api/_ask.js`（上列介面）、`api/ask.js`（handler 照 `bottles.js` 風格：`no-store`、未設定 503、例外 502；POST 驗證順序：vid → clean → 長度 → BLOCK → 里名 → 開關 → 速率），`server.js` 加路由，`bottles.js` 匯出，`fake-upstash.js` 補指令。`readAll` 一個 pipeline 讀 `HGETALL Q`、`SMEMBERS HIDDEN`、`SMEMBERS EXCLUDED`、`HGETALL SRC`、`HGETALL VOTES`、`HGETALL OPEN`。POST 成功後 `invalidate()`。
- [ ] **Step 4: 跑** `node --test test/ask.test.js` 與 `npm test`，預期全部 PASS。
- [ ] **Step 5: Commit**（只加本 task 檔案，帶 pathspec）`feat(ask): 提問 API 與資料層`

---

### Task 3: 島上留言同步進提問列表

**Files:**
- Modify: `api/_ask.js`（`readAll` 內）
- Test: `test/ask.test.js`（`describe('島上同步')`）

**Interfaces:**
- Consumes: Task 2 的 `readAll`、`K`
- Produces: `readAll()` 行為擴充，對外介面不變

規則：`readAll` 的 pipeline 加 `LRANGE K.BOTTLES 0 KEEP-1`。清單裡每一則：`JSON.parse` 失敗、不是物件、`id` 不是字串、`text` 不是非空字串的都略過；`K.Q` 已有該 id 就跳過；`ask` 欄位為真的也跳過（它應已在 `K.Q`）。其餘用 `HSETNX K.Q id JSON({id, t:Number(t)||0, text, name:name||'匿名鎮民', vil:'', origin:'island', src:'online', raw:原字串})` 補建；若 `OPEN.online==='0'` 且 `t > closedAt`，同一 pipeline 加 `SADD K.EXCLUDED id`。補建後回傳的 questions 要包含這些新筆（不必再讀一次）。

- [ ] **Step 1: 寫失敗測試：**
  - 預先 `LPUSH P+'bottles'` 三則：正常 `{id:'b1',t:1000,text:'加油',name:''}`、壞字串 `'not json'`、`{id:5,text:'x'}`；GET → 只多 `b1`，`origin==='island'`、`vil===''`、`name==='匿名鎮民'`，回 200。
  - 再 GET 一次，`HGETALL P+'ask:q'` 仍只有一筆 `b1`（不重複補建）。
  - `HSET P+'ask:open' online 0 closedAt 5000`，再 LPUSH `{id:'b2',t:4000,...}` 與 `{id:'b3',t:6000,...}`；GET 後 `SMEMBERS P+'ask:excluded'` 含 `b3`、不含 `b2`。
  - `HSET P+'ask:open' online 1`，LPUSH `{id:'b4',t:7000,...}`；GET 後 excluded 不含 `b4`。
  - 活動頁提問（`ask:1`）不會被當成 island 再建一筆。
- [ ] **Step 2: 跑**，預期 FAIL。
- [ ] **Step 3: 實作。**
- [ ] **Step 4: 跑** `node --test test/ask.test.js` 與 `npm test`，預期 PASS。
- [ ] **Step 5: Commit** `feat(ask): 島上留言自動進提問列表`

---

### Task 4: 我也想問

**Files:**
- Create: `api/ask-vote.js`
- Modify: `server.js`（`ROUTES` 加 `'/api/ask-vote'`）
- Test: `test/ask.test.js`（`describe('我也想問')`）

**Interfaces:**
- Consumes: `K`、`invalidate`；存在與隱藏用一個 pipeline 的 `HGET K.Q id`、`SISMEMBER K.HIDDEN id` 判斷（`fake-upstash.js` 一併補 `SISMEMBER`）
- Produces: `POST /api/ask-vote {vid, id, on: boolean}` → 200 `{ id, votes, on }`

規則：題目不存在或已隱藏 → 404 `{error:'not found'}`。IP 取 `x-forwarded-for` 第一段（沒有就用 socket 位址），`INCR K.VRL(ip,hour)`＋`EXPIRE 7200`，超過 `VOTE_IP_HOUR_MAX` → 429 `busy`。`on:true`：`SADD K.VOTERS(id) vid` 回 1 才 `HINCRBY K.VOTES id 1`；`on:false`：`SREM` 回 1 才 `HINCRBY -1`。回傳目前次數（不小於 0）。成功後 `invalidate()`。收題開關不影響投票。

- [ ] **Step 1: 寫失敗測試：**
  - 同 vid `on:true` 兩次 → 兩次都 200，`votes===1`；`on:false` → `votes===0`；再 `on:false` → 仍 0。
  - 兩個不同 vid、同一 `x-forwarded-for: 1.2.3.4` → `votes===2`。
  - 預設 `SET K.VRL('1.2.3.4',hour) '400'` 後再投 → 429 `busy`；另一 IP 照常 200。
  - 不存在的 id → 404；`SADD hidden id` 後投 → 404。
  - `HSET P+'ask:open' online 0` 後投 → 仍 200。
  - 投票後 `GET /api/ask` 該題 `votes` 立即更新（快取已清）。
- [ ] **Step 2: 跑**，預期 FAIL。
- [ ] **Step 3: 實作。**
- [ ] **Step 4: 跑** `node --test test/ask.test.js` 與 `npm test`，預期 PASS。
- [ ] **Step 5: Commit** `feat(ask): 我也想問`

---

### Task 5: 後台 API

**Files:**
- Create: `api/ask-admin.js`、`test/ask-admin.test.js`
- Modify: `api/admin.js`（檔尾匯出 `getState`、`sameOrigin`、`who`）、`server.js`（`ROUTES` 加 `'/api/admin/ask'`）

**Interfaces:**
- Consumes: `getState(req) → { users, sess }`、`sameOrigin(req) → boolean`、`who(name, u)`（admin.js）；`readAll`、`invalidate`、`K`、`KEEP`（_ask.js）；`adminCookie`（helpers）
- Produces:
  - `GET /api/admin/ask` → 200 `{ user, open, questions: Question 去掉 raw }`；未登入 401
  - `POST /api/admin/ask {op, ...}`（需 `application/json` 否則 415；`sameOrigin` 否則 403；未登入 401；未知 op 400 `bad op`；id 不存在 404）→ 200 `{ ok: true }`。op：
    - `hide {id}`：`SADD HIDDEN`、`SADD EXCLUDED`、`LREM BOTTLES 0 raw`
    - `unhide {id}`：`SREM HIDDEN`、`LREM BOTTLES 0 raw`、`LPUSH BOTTLES raw`、`LTRIM 0 KEEP-1`（不動 EXCLUDED）
    - `exclude {id}` / `include {id}`：`SADD` / `SREM EXCLUDED`
    - `src {id, src: 'online'|'live'}`：`HSET SRC id src`，其他值 400
    - `open {which: 'online'|'live', open: boolean}`：`HSET OPEN which '1'|'0'`；`which==='online' && !open` 時同時寫 `closedAt = Date.now()`
  - 每個成功的 POST 都 `invalidate()`

- [ ] **Step 1: 寫失敗測試**（`test/ask-admin.test.js`，用 `adminCookie(env,'smalt')`）：
  - 無 cookie GET／POST → 401。
  - 帶 `Origin: http://evil.example` 的 POST → 403；`content-type: text/plain` → 415。
  - 活動頁提問 `hide` 後：`GET /api/ask` 不含（不等 5 秒）；`LRANGE bottles` 不含；`SMEMBERS excluded` 含；`GET /api/admin/ask` 該題 `hidden===true`。
  - 島上來的瓶子（先 LPUSH，GET 觸發同步）`hide` 後 `LRANGE bottles` 不含那則原字串。
  - `unhide` 後：`GET /api/ask` 又看得到；`LRANGE bottles` 恰好一則；`excluded` 仍含。
  - `include` 後 excluded 不含；`exclude` 後含。
  - `src live` 後 admin 與公開列表 `src==='live'`；`src 'x'` → 400。
  - `open online false` → `HGET open closedAt` 是數字；之後 `POST /api/ask` 線上 → 403；`open online true` → 201。
  - 已隱藏的題目不會因 `GET /api/ask` 的同步回到公開列表或島上清單。
- [ ] **Step 2: 跑** `node --test test/ask-admin.test.js`，預期 FAIL。
- [ ] **Step 3: 實作。**
- [ ] **Step 4: 跑** `node --test test/ask-admin.test.js` 與 `npm test`，預期 PASS（含 `test/reply.test.js`，確認 admin.js 匯出沒弄壞原功能）。
- [ ] **Step 5: Commit** `feat(ask): 後台 API`

---

### Task 6: 依網域分流＋鎮民頁

**Files:**
- Create: `ask.html`、`test/ask-pages.test.js`
- Modify: `server.js`（`serveStatic` 改吃頁面表參數）

**Interfaces:**
- Consumes: `GET/POST /api/ask`、`POST /api/ask-vote`
- Produces: `pagesFor(req): Record<string,string>`（server.js 內）：Host 取 `x-forwarded-host` 第一段，沒有就 `host`，去掉 port、轉小寫；以 `ask.` 開頭時回 `{ ...PAGES, '/': '/ask.html', '/admin': '/ask-admin.html' }`，否則回 `PAGES`。`PAGES` 本身加 `'/ask': '/ask.html'`、`'/ask-admin': '/ask-admin.html'`（本機開發用）。

`ask.html` 照雛形鎮民頁：標題「鎮妹！給問嗎？」、眉標「草屯鎮長 政見發表會 會後活動」；表單（暱稱可空、里別下拉來自 `GET /api/ask` 的 `villages`、問題 120 字含字數）；`?live=1` 時顯示現場提示並送 `live:true`；送出後清空並顯示「已丟進留言瓶，也漂到政策島上了」；錯誤碼對應中文訊息（`slow down`→「每台手機 45 秒可以送一題，稍等一下」、`closed`→「提問已經截止」、`blocked`→「問題裡不能放網址或不雅字」、`bad village`→「請選你住的里」、`too short`→「問題至少寫 2 個字」、`busy`→「現在人太多了，等一下再試」、其他→「送出失敗，請再試一次」）；對應開關關閉時表單換成「已截止」說明；列表兩個分頁「最多人想問」「最新」（已回答分頁留給第二段）；每題「我也想問」按鈕，已按過的題目 id 存在 `localStorage`（try/catch），按下送 `on` 為切換後狀態並以回應的 `votes` 更新；分頁可見時每 15 秒重抓列表；島上來的題目標「政策島留言」、現場題標「現場」。vid 存在 `localStorage` 的 `ask:vid`，格式 `/^[a-z0-9]{6,32}$/`。所有文字用 `textContent` 或跳脫後插入。手機寬優先，桌面置中 470px。

- [ ] **Step 1: 寫失敗測試** `test/ask-pages.test.js`：
  - `GET /` + `Host: ask.542upup.tw` → 200 `text/html`，內容含「鎮妹！給問嗎？」。
  - `GET /` + `Host: island.542upup.tw` → 內容含「草屯政策島」、不含「鎮妹！給問嗎？」。
  - `GET /` + `Host: x` + `x-forwarded-host: ask.542upup.tw` → 鎮民頁。
  - `GET /admin` + ask Host → `ask-admin.html`（本 task 先放最小佔位檔，內容含「鎮妹給問後台」；Task 7 換掉）。
  - `GET /ask` 任何 Host → 鎮民頁；`GET /admin` + island Host → 404。
- [ ] **Step 2: 跑** `node --test test/ask-pages.test.js`，預期 FAIL。
- [ ] **Step 3: 實作** `pagesFor`、`ask.html`、佔位 `ask-admin.html`。
- [ ] **Step 4: 跑** `node --test test/ask-pages.test.js` 與 `npm test`，預期 PASS。
- [ ] **Step 5: 本機手動驗證**（接假 Upstash）：`node dev/fake-upstash.js --port 8079 --seed dev/sample-bottles.json` 與 `KV_REST_API_URL=http://127.0.0.1:8079 KV_REST_API_TOKEN=dev PORT=8091 node server.js`，開 `/ask` 與 `/ask?live=1`：送一題出現在「最新」第一則；按「我也想問」數字加 1、重整後仍是按下狀態；島上 seed 瓶子出現在列表並標「政策島留言」；手機寬 390px 無水平捲動。截圖存 scratchpad 給使用者看。
- [ ] **Step 6: Commit** `feat(ask): 鎮民頁與網域分流`

---

### Task 7: 後台頁

**Files:**
- Modify: `ask-admin.html`（取代佔位檔）

**Interfaces:**
- Consumes: `GET /api/admin`（`{ready, authed, user}`）、`POST /api/admin {op:'login', username, password}`（同 `reply.html` 的登入流程與錯誤處理）、`GET/POST /api/admin/ask`

照雛形後台：未登入顯示登入表單；登入後顯示兩個開關（線上提問、現場 QR 提問，按鈕文字「截止線上提問」／「重新開放」等）、統計（題數、公開、線上抽選庫、現場抽選庫、已隱藏）、篩選（全部／線上／現場／政策島留言／已隱藏／已排除抽選）、說明句「隱藏＝活動頁列表和政策島留言瓶一起拿掉，同時排除抽選；恢復公開後要另外按「放回抽選」才會再被抽到。」；每題顯示文字、暱稱·里別、時間、來源與狀態標籤、我也想問次數、抽中機率（抽選庫＝未隱藏、未排除，依 `src` 分池，權重 `1 + Math.sqrt(votes)`，不在庫顯示「不在抽選庫」），按鈕「隱藏／已隱藏，恢復公開」「排除抽選／已排除，放回抽選」、來源下拉。每次操作後重抓列表；401 時回登入畫面；每 20 秒自動重抓。

- [ ] **Step 1: 本機手動驗證**（假 Upstash＋用 `scripts/reply-setup.js` 對假 Upstash 建帳號）：登入；隱藏一題後 `/ask` 列表與島上都看不到、該題顯示「已排除抽選」；恢復公開後仍排除；改來源為現場後 `/ask` 標「現場」；截止線上提問後 `/ask` 顯示已截止、`/ask?live=1` 仍可送；機率加總每池為 100%。截圖存 scratchpad。
- [ ] **Step 2: 跑** `npm test`，預期 PASS。
- [ ] **Step 3: Commit** `feat(ask): 後台頁`

---

### Task 8: 島上「鎮妹給問」標籤

**Files:**
- Modify: `index.html`（瓶子材質與 `openBottle` 紙條 HTML，約 4160–4240 行）、`dev/sample-bottles.json`（加一則 `ask:1`、`vil` 的範例）
- Test: `test/ask-pages.test.js`

規則：`msg.ask` 為真的瓶子，緞帶用黃色 `#fcea8b`（其他維持珊瑚）；打開後紙條上方加標籤「鎮妹給問」，暱稱後顯示里別（有的話），紙條下方加連結「到活動頁看大家的問題」指向 `https://ask.542upup.tw/`（`target="_blank" rel="noopener"`）。英文模式標籤用 `Ask Yuan-ting`。

- [ ] **Step 1: 寫失敗測試**：`GET /`（island Host）HTML 含 `bottle-ask` 與「鎮妹給問」與 `https://ask.542upup.tw/`。
- [ ] **Step 2: 跑**，預期 FAIL。
- [ ] **Step 3: 實作。**
- [ ] **Step 4: 跑** `npm test`，預期 PASS。
- [ ] **Step 5: 本機手動驗證**：假 Upstash seed 含活動瓶，打開島上那瓶看到標籤、里別與連結，一般瓶子不變。截圖存 scratchpad。
- [ ] **Step 6: Commit** `feat(island): 活動瓶子貼鎮妹給問標籤`

---

### Task 9: 上線（每一步都要使用者當場確認）

- [ ] **Step 1:** 跑 `npm test` 全過，附上輸出摘要。原生 `codex review`（沙盒內加 `-c sandbox_mode="danger-full-access"`）審 `zeabur` 分支本段差異到 clean。
- [ ] **Step 2:** 請使用者在 Cloudflare 新增 `ask`：A 記錄 → `172.105.219.141`，橘雲（比照 `island`），由使用者按儲存。
- [ ] **Step 3:** 使用者同意後，在 Zeabur 服務 `6adf5dffe88b9f72265c5dfe`（環境 `6a71f6025f062718bc7b33f3`）綁 `ask.542upup.tw`，等到 PROVISIONED。
- [ ] **Step 4:** 使用者 `!git push origin zeabur`（或當場授權由我推），再 `npx zeabur@latest service redeploy -i=false -y --id 6adf5dffe88b9f72265c5dfe --env-id 6a71f6025f062718bc7b33f3`，約 1–2 分鐘 RUNNING。
- [ ] **Step 5:** 線上只做 GET 驗證：`curl -s https://ask.542upup.tw/ | grep 鎮妹`、`curl -s https://ask.542upup.tw/api/ask | head -c 300`（確認舊瓶子已同步進來）、`curl -s https://island.542upup.tw/ | grep bottle-ask`。不要對正式站送測試提問；第一則真實提問由使用者送，送完一起看列表、島上、後台。
- [ ] **Step 6:** 提醒使用者：活動前要在後台把島上「加油」類留言排除；現場 QR 網址是 `https://ask.542upup.tw/?live=1`。
