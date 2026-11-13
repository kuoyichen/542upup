# 鎮妹！給問嗎？第二段（投影抽題）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 活動現場用接投影的筆電抽題（拉霸、線上／現場輪流、斷線不卡），回答過的題目標已回答、貼影片，活動頁與島上瓶子都看得到媛婷的回答。

**Architecture:** 沿用第一段的資料層 `api/_ask.js` 與後台 API `api/ask-admin.js`，加三個狀態（已回答、已抽出、影片網址）與四個後台操作；抽題頁 `ask-draw.html` 只讀後台 API 的快照、在頁面本地算權重抽題，再向伺服器「認領」那一題。回覆寫進既有的 `542upup:replies`，島上「媛婷回覆」區塊加影片連結。

**Tech Stack:** Node ≥20.12（無套件）、Upstash REST、原生 HTML/CSS/JS、`node --test`。

**Spec:** `docs/superpowers/specs/2026-11-06-zhenmei-ask-design.md`（第 5.2、6.5、7、8、9 節，第 11 節第二段）。雛形：https://claude.ai/artifact/Udxf66upqjYDHZ7fw7KqGM（投影抽題分頁）。第一段計畫：`docs/superpowers/plans/2026-11-06-zhenmei-ask-phase1.md`。

## Global Constraints

- 只在 `zhenmei-ask` 分支開發與 commit（worktree `.worktrees/zhenmei-ask`），不推送；上線前跑原生 `codex review` 到沒有 P1／P2，推送、部署由使用者確認。
- 測試與本機開發絕不碰正式 Upstash：用 `test/helpers/server-env.js` 的 `start()`（每個測試行程只能呼叫一次，新 describe 一律巢在檔案既有的最外層 describe 底下）、`adminCookie(env, name)`；本機起 server 一律接 `dev/fake-upstash.js`。
- 零依賴，不加 npm 套件，前端不載外部 JS 函式庫。
- `542upup:bottles`、`542upup:replies` 的每筆格式只能加欄位（原作者 Vercel 版共用）。
- 抽選庫＝未隱藏、未排除、未回答、未抽出；權重 `1 + Math.sqrt(votes)`；線上池＝`src: 'online'`，現場池＝`src: 'live'`。
- 投影畫面絕不顯示已隱藏的題目。
- UI 文字繁體中文；中文裡的半形標點後接空格；不用 emoji 或裝飾性 unicode；使用者字串一律 `textContent` 或跳脫。
- 影片網址只收 `https://` 開頭、最長 300 字。
- 回覆固定文字：`這題在「鎮妹！給問嗎？」活動中回答了，點下面看影片。`
- `npm test` 全過（基準 182）。

**本計畫新增的決定（spec 沒寫，我的決定）：**
- 抽題頁要先在 `/admin` 登入（共用同一個 cookie），抽題頁本身不放登入表單；沒登入時提供「用示範資料預演」，只在頁面內跑、不送任何寫入，方便團隊彩排。
- 「認領」：抽中後送 `draw {id}`，伺服器確認還在抽選庫才標已抽出，否則回 409，頁面換一題重抽。這同時滿足 spec 7「動畫開始就向伺服器確認」。
- 現場 QR code 做成靜態檔 `ask-qr.svg`（內容 `https://ask.542upup.tw/?live=1`），會場網路不好也顯示得出來。
- 「我也想問」每 IP 每小時上限從 400 提高到 1000：會場幾百人共用一個 IP，而且 cf-connecting-ip 本來就能被直連偽造，低上限擋不了壞人只會擋到觀眾。
- 鎮民頁「最多人想問」分頁按了「我也想問」後只更新數字，不立刻重排（第一段延後的小問題）。

## Review Focus

1. 抽題頁的快照過期：快照之後才被隱藏或排除的題目被本地抽中。期望：認領回 409，頁面換題，投影上不出現。Task 1 測 409；Task 3 測頁面的換題邏輯（以示範資料模式的可測函式）。
2. 會場斷線：認領逾時或失敗時，結果照常顯示、操作進佇列，恢復後依序送出，重整頁面後佇列還在。Task 3。
3. 回覆被覆蓋：題目原本就有媛婷用 /reply 寫的回覆，貼影片後原文字消失。期望：原文字與 `by` 保留，只補影片網址；清掉影片只拿掉網址。Task 2。
4. 已回答的題目在活動頁列表消失或又被抽到。期望：已回答照常公開、標「活動中已回答」、不在抽選庫。Task 1、Task 4。
5. 惡意影片網址（`javascript:`、`data:`、帶引號的字串）出現在活動頁或島上。期望：伺服器只存 `https://`，頁面再檢查一次並跳脫。Task 1、Task 2、Task 4。

---

## 資料 key（加進 `_ask.js` 的 `K`）

```js
ANSWERED: P + 'ask:answered', // set
DRAWN: P + 'ask:drawn',       // set：已抽出、還沒處理
VIDEO: P + 'ask:video',       // hash id → https 網址
REPLIES: P + 'replies',       // 既有 hash，瓶子 id → JSON {text,t,by,url?}
```

---

### Task 1: 已回答、已抽出、影片的資料層與後台操作

**Files:**
- Modify: `api/_ask.js`（`K`、`readAll`、公開欄位）、`api/ask-admin.js`（新 op）
- Test: `test/ask-admin.test.js`、`test/ask.test.js`

**Interfaces:**
- Produces:
  - `readAll()` 的 `Question` 多 `answered: boolean`、`drawn: boolean`、`video: string`（沒有則 `''`）
  - `readPublic()` 的 `PublicQuestion` 多 `answered: boolean`、`video: string`（未回答一律 `''`）；不含 `drawn`
  - 常數 `VIDEO_MAX = 300`、`VOTE_IP_HOUR_MAX = 1000`
  - `POST /api/admin/ask` 新 op（驗證、守門同既有 op）：
    - `draw {id}`：題目不在抽選庫（隱藏、排除、已回答）→ 409 `{error:'unavailable'}`；`SADD DRAWN id` 回 0（已被抽出）→ 409；否則 200 `{ok:true}`
    - `putback {id}`：`SREM DRAWN id`
    - `answer {id, on: boolean}`：`on` → `SADD ANSWERED`、`SREM DRAWN`；`!on` → `SREM ANSWERED`、`HDEL VIDEO`，並呼叫 Task 2 的回覆同步清掉影片（Task 1 先留一個 `syncReply` 呼叫點，Task 2 實作；本 task 用 no-op 版本）
    - `video {id, url}`：題目未回答 → 409 `{error:'not answered'}`；`url === ''` → `HDEL VIDEO`；否則必須 `/^https:\/\/\S+$/` 且長度 ≤ `VIDEO_MAX`，不符 400 `{error:'bad url'}`，符合 → `HSET VIDEO id url`；之後呼叫 `syncReply`
  - 既有 `exclude`、`hide` 也 `SREM DRAWN id`
  - 每個成功的 POST 都 `invalidate()`

- [ ] **Step 1: 寫失敗測試：**
  - `draw` 一題 → 200；GET admin 該題 `drawn===true`；公開 GET 不含 `drawn` 欄位；同一題再 `draw` → 409；`putback` 後可再 `draw`。
  - 隱藏、排除、已回答的題目 `draw` → 409 `unavailable`。
  - `exclude` 與 `hide` 會清掉 `drawn`。
  - `answer on` → admin `answered===true`、`drawn===false`；公開 GET `answered===true` 且題目仍在列表；`answer off` → `answered===false`、`video===''`。
  - `video` 對未回答題 → 409；`javascript:alert(1)`、`http://x`、301 字的 https 網址 → 400；合法 https → admin 與公開 `video` 都是該網址；`url:''` → 清空。
  - `VOTE_IP_HOUR_MAX` 為 1000（把既有 400 的測試改成 1000）。
- [ ] **Step 2: 跑** `node --test test/ask-admin.test.js test/ask.test.js`，預期 FAIL。
- [ ] **Step 3: 實作。**
- [ ] **Step 4: 跑** 同上與 `npm test`，預期 PASS。
- [ ] **Step 5: Commit** `feat(ask): 已回答、已抽出、影片網址與抽題認領`

---

### Task 2: 回覆附影片（活動頁之外，島上也看得到）

**Files:**
- Modify: `api/_ask.js` 或 `api/ask-admin.js`（`syncReply`）、`api/replies.js`（`parseReplies` 帶 `url`）、`index.html`（`replyBlock`）
- Test: `test/ask-admin.test.js`、`test/reply.test.js`（只加不改）、`test/ask-pages.test.js`

**Interfaces:**
- Consumes: Task 1 的 `video`／`answer` op 呼叫點
- Produces: `async syncReply(id, url, by): void`：
  - `url` 非空：`HGET REPLIES id`；沒有 → `HSET` `{text: 固定文字, t: Date.now(), by, url}`；有 → 保留原 `text`、`t`、`by`，只設 `url`
  - `url` 為空：沒有回覆 → 不動；`text` 等於固定文字 → `HDEL`；否則 → 寫回去掉 `url` 的物件
  - `by` 是操作的後台帳號名（`getState` 的 `sess.name`）
- `parseReplies`：`url` 是字串且符合 `/^https:\/\/\S+$/` 時一併輸出；公開 `/api/replies` 因此帶 `url`，仍不帶 `by`
- 島上 `replyBlock`：有 `url` 時在回覆文字下方加 `<a class="rv" href="..." target="_blank" rel="noopener">看回答影片</a>`（英文 `Watch the answer`），`href` 用既有 `esc()` 跳脫，且前端再檢查 `https://` 開頭

- [ ] **Step 1: 寫失敗測試：**
  - 沒有回覆的題目貼影片 → `HGET replies id` 的 `text` 為固定文字、`url` 正確、`by` 為 `smalt`；`/api/replies` 該 id 有 `url`、沒有 `by`。
  - 先用 `/api/admin {op:'reply'}`（照 `test/reply.test.js` 的寫法）寫一則人工回覆，再貼影片 → `text`、`by` 不變，多了 `url`。
  - 清掉影片：人工回覆 → 只剩原文字；固定文字回覆 → 整則被刪；`answer off` 同樣清掉影片。
  - `replies` 裡塞一則 `url:'javascript:x'` → `/api/replies` 不輸出 `url`。
  - 島上 HTML 含 `看回答影片` 與 `class="rv"`。
- [ ] **Step 2: 跑** `node --test test/ask-admin.test.js test/reply.test.js test/ask-pages.test.js`，預期 FAIL。
- [ ] **Step 3: 實作。**
- [ ] **Step 4: 跑** 同上與 `npm test`，預期 PASS。
- [ ] **Step 5: Commit** `feat(ask): 回答影片寫進媛婷回覆，島上顯示影片連結`

---

### Task 3: 投影抽題頁

**Files:**
- Create: `ask-draw.html`、`ask-qr.svg`
- Modify: `server.js`（`ASK_PAGES` 加 `'/draw': '/ask-draw.html'`、`PAGES` 加 `'/ask-draw': '/ask-draw.html'`）
- Test: `test/ask-pages.test.js`

**Interfaces:**
- Consumes: `GET /api/admin/ask`（`{user, open, questions:[...answered, drawn, video, hidden, excluded, src, origin, votes, name, vil, text]}`）、`POST /api/admin/ask` 的 `draw`／`putback`／`answer`／`exclude`
- `ask-qr.svg`：用 AITeam venv 的 segno 產生一次並 commit：`/Users/smalt/AITeam/venv/bin/python3 -c "import segno; segno.make('https://ask.542upup.tw/?live=1', error='m').save('ask-qr.svg', scale=8, border=2, dark='#163238', light='#ffffff')"`；產生指令寫在 `ask-draw.html` 的註解

版面照雛形「投影抽題」分頁：16:9 深色舞台（固定一套顏色），左上「鎮妹！給問嗎？」、右上「第 N 題 · 線上題／現場 QR 題／現場舉手」、中間待機／拉霸／結果／舉手四種畫面、左下 QR code 與「現場掃碼提問 ask.542upup.tw」、右下按鍵提示；舞台下方操作列（全螢幕時隱藏）：模式切換、抽題、回答完下一題、不算放回去、排除這題、全螢幕、兩池題數。結果卡顯示題目、`暱稱 · 里別`（島上留言顯示 `暱稱 · 政策島留言`）、`N 人也想問`（0 不顯示）、線上／現場提問。

行為（spec 第 7 節＋本計畫決定）：
- 開頁先 `GET /api/admin/ask`。401 → 顯示「請先到後台登入」與連到 `/admin` 的按鈕，以及「用示範資料預演」按鈕（內建 8 題假資料，所有寫入改成只在頁面內生效）。
- 快照：開頁時抓一次，待機時每 15 秒更新；每次操作成功後也更新。抽選庫依 Global Constraints 在頁面本地算。
- 開頁若快照裡有 `drawn && !answered` 的題目，先以結果畫面顯示「上次抽出、還沒處理」那題。
- 抽題（空白鍵）：本地加權抽一題，開始約 3.6 秒拉霸動畫（`prefers-reduced-motion` 時 0.3 秒），同時送 `draw {id}`、逾時 1500 毫秒：
  - 200 → 照常停在這題
  - 409 → 把這題從本地快照標成不可抽，立刻換一題重新認領（同一次動畫內，最多重試 5 次；池子抽完就顯示「這個池子沒有題目了」）
  - 逾時或網路錯誤 → 照常顯示，操作列（不在舞台上）顯示「離線抽題，未確認」，`draw` 進佇列
- 佇列：所有寫入（`draw`、`answer`、`putback`、`exclude`）失敗或逾時都進佇列，存在 `localStorage`（try/catch），每 5 秒依序重送；伺服器回 4xx 的那筆丟掉不再重試；401 → 提示重新登入。佇列非空時操作列顯示「N 筆還沒送出」。
- 按鍵：空白鍵抽題、Enter 回答完（`answer on`）並換邊、R 放回（`putback`）、X 排除（`exclude`）、F 全螢幕、1／2／3 指定線上題／現場 QR 題／現場舉手。輸入框聚焦時不攔截。
- 換邊：每題結束自動 線上 → 現場 → 線上；輪到現場時現場池是空的就切「現場舉手」。舉手畫面顯示「現場舉手提問」與「請工作人員把麥克風遞給舉手的鄉親」，Enter 結束這輪。
- 待機畫面：大字「給問嗎？」、「已經收到 N 個問題 · 抽選庫線上 a、現場 b」、「下一題：…」、「按空白鍵開始抽」。
- 頁面把「加權抽題」「409 換題」「換邊」寫成可在 Node 測試裡 require 不到的純前端函式即可，不必拆檔；正確性靠 Step 4 的示範模式手動驗證與 Task 3 審查。

- [ ] **Step 1: 寫失敗測試**（`test/ask-pages.test.js`）：ask Host `GET /draw` 與任何 Host `GET /ask-draw` → 200，含「鎮妹！給問嗎？」與 `ask-qr.svg`；island Host `GET /draw` → 404；`GET /ask-qr.svg` → 200 `image/svg+xml`。
- [ ] **Step 2: 跑**，預期 FAIL。
- [ ] **Step 3: 實作** 路由、QR 檔、`ask-draw.html`。
- [ ] **Step 4: 跑** `npm test`，預期 PASS；再用本機假 Upstash 起 server，以 curl 走一遍：後台 cookie 下 `draw`→`answer`、`draw`→`putback`、隱藏後 `draw` 回 409。瀏覽器畫面交給 controller 用示範資料模式截圖。
- [ ] **Step 5: Commit** `feat(ask): 投影抽題頁`

---

### Task 4: 後台與鎮民頁的已回答

**Files:**
- Modify: `ask-admin.html`、`ask.html`
- Test: `test/ask-pages.test.js`

後台（照雛形後台分頁）：每列加「已回答」勾選（`answer`）、勾了之後出現「回答影片」網址輸入框（離開輸入框或按 Enter 送 `video`，400／409 顯示在該列）、「剛抽出」標籤與「放回抽選」按鈕（`putback`）；篩選加「已回答」；統計加「已回答」。抽中機率與抽選庫計算排除已回答與剛抽出。頂部加一個連到 `/draw` 的「開投影抽題」連結。

鎮民頁：恢復「已回答」分頁（只列 `answered`）；已回答的題目在每個分頁都顯示「活動中已回答」標籤，有影片顯示「看媛婷怎麼回」連結（`https://` 才顯示，`target="_blank" rel="noopener"`），沒有顯示「回答影片整理中」；「最多人想問」分頁按「我也想問」後只更新數字，不立刻重排，換分頁或下次自動更新才重排。

- [ ] **Step 1: 寫失敗測試**：`/ask` HTML 含「已回答」分頁按鈕與「看媛婷怎麼回」；`/ask-admin` HTML 含「回答影片」與「放回抽選」與 `/draw`。
- [ ] **Step 2: 跑**，預期 FAIL。
- [ ] **Step 3: 實作。**
- [ ] **Step 4: 跑** `npm test`，預期 PASS；本機假 Upstash 下 curl 確認後台操作後 `/api/ask` 的 `answered`、`video` 正確。
- [ ] **Step 5: Commit** `feat(ask): 後台標已回答與貼影片，鎮民頁顯示回答`

---

### Task 5: 審查與上線（controller 執行，每一步使用者確認）

- [ ] **Step 1:** `npm test` 全過。
- [ ] **Step 2:** 原生 Codex 審查（沙盒內）：`codex review --base 8593f69 --disable hooks -c sandbox_mode='"danger-full-access"'` 加 worktree 的 untrusted projects 覆寫，`allowed_domains` 為 chatgpt.com、*.chatgpt.com、api.openai.com、*.openai.com。P1／P2 交給一個修正 agent 一次修完，再跑一次 Codex 到沒有 P1／P2。
- [ ] **Step 3:** controller 用 Chrome 外掛開 tailnet 開發站（接假 Upstash）截投影頁示範模式的待機、拉霸、結果、舉手，傳 Telegram 給使用者。
- [ ] **Step 4:** 使用者 `!` 合併推送（ff-only 到 zeabur）並跑 Zeabur redeploy；controller 線上只做 GET 驗證（`/draw` 200、`/api/ask` 帶 `answered`）。
- [ ] **Step 5:** 提醒使用者：活動前在投影筆電先登入 `/admin` 再開 `/draw`，用「用示範資料預演」彩排；活動前排除島上「加油」類留言。
