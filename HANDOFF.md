# 交接说明（给下一个会话）

> 上一轮会话很长，上下文已满。这份文档让新会话**不必重新推导**。
> 配套阅读：`PRINCIPLES.md`（工作与产品原则，含"先说改动内容、确认后再改"这条硬规矩）。

---

## 一、当前状态

- **自检 340 项全过（TEST_OK，PASS 340 / FAIL 0）**（2026-09-27：三个体验修复 + 教学助手更名/素材库 + 行为系统重做后复跑，见下方第四/五/六批）
- **v3.2.0 代码已就绪、产物已本地打出**（`release/SmartCounterIsland-3.2.0-portable.exe` 71.3 MB / `-Setup-3.2.0.exe` 71.6 MB），但**还没发到 GitHub** —— 见下方「发布链路的两个坑」。 —— 2026-09-26 复跑时 `T18/T21/T22/T23` **也全绿**。它们原先恒红是**运行环境**问题：受限沙箱下 electron 建不出窗口进程（`FATAL:platform_channel.cc 拒绝访问 (0x5)` + `network_sandbox` 授权失败），不是代码问题。跑自检请用正常桌面/非受限环境。
- **v3.1.0 已发布**：<https://github.com/SenbonFanKageyoshi/smart-counter-island/releases/tag/v3.1.0>
- **代码里没有半成品**：所有没做成的尝试都已回退，且失败原因写进了对应代码的注释。
- **未提交的改动**（按 `git status` 现状，2026-09-26 核对）：已修改 `src/main/config.js`、`src/main/island.js`、`src/main/main.js`、`src/main/settings.js`、`src/renderer/config/config.css`、`src/renderer/config/index.html`、`src/renderer/island/island.js`；未跟踪 `.github/`、`HANDOFF.md`、`src/renderer/config/reward/`、`release-notes-3.0.1.md`。
- **不属于本项目、别提交**：`pyproject.toml`、`requirements.txt`、`tests/`、`waste_electrolysis_analyzer/`、`reward/`、`.renumber-tmp/`。

---

## 二、下一步：先还工程债（按修正后的顺序）

| 序 | 项 | 状态 | 具体做什么 |
|---|---|---|---|
| 1 | **死参数 `expandedSinceMs`** | ✅ 已完成 2026-09-26 | `decideState` 签名删掉该参数；`this.expandedAt` 的 3 处赋值 + 3 组测试夹具字段一并删（`island.js` 5 处 + `main.js` 4 处，见第六节） |
| 2 | **settings 迁移表** | ✅ 已完成 2026-09-26 | `settings.js` 加 `schemaVersion: 1` + `MIGRATIONS` 版本链 + 纯函数 `applyMigrations`；旧 `version: 3` 废弃（无人读）；散装迁移拆成"一次性链"与"每次加载的兜底" |
| 3 | **断言改成测不变量** | 🟡 部分完成 2026-09-26 | 细条自适应落地时已把 T29 命中区域、T30 两条写死 `229/116` 的断言改成**实时期望 + 轮询去竞态**，并新增两条不变量断言。其余写死像素的断言仍待清理。**这也是第 ② 项的前置条件** |
| 4 | **测试独立成 `tests/`** | 中高 | 从 5800 行的 `src/main/main.js` 里剥出来 |
| 5 | **拆 `src/main/island.js`**（2300 行）+ 理掉绕循环依赖的延迟 `require` | 高 | 必须小步，每步自检全绿再继续 |
| 6 | 清理 `expanded`（横幅）形态 | 中 | ⚠️ **别急着做**：产品侧确实没有入口，但 `--shot-*` / `--perf` / 几何自检有 **7 处** `manualState('expanded', …)` 依赖它，删状态要连带重写这些工具 |

---

## 三、已解决：细条宽度自适应（2026-09-26，第 5 次尝试成功）

**用户诉求**：细条两侧各有约 19.5px 的等宽空白（内容 190 装在 229 的行程里，多出的 39px 被 `justify-content:center` 平分成两侧）。

**最终公式（这就是全部答案）**：
> 窗口宽 = 额度 `E` + 禁区宽 + 槽位；**E = 左瓣 + 右瓣 + 2×行内间距（`.s-row { gap: 5px }` → 10px）+ 2×两侧留白**
> 两侧留白 = `STRIP_SIDE_PAD`（`island.js` 顶部常量，当前 **6px**）；0 = 内容紧贴窗口边与禁区，视觉太割裂。

- 行结构就是 `[.nb-l][.nb-gap 禁区+槽位][.nb-r]`，空白量 = (E − 内容宽)/2 —— 病根就是 E 写死 116。
- **那 10px 的行内间距必须算进内容宽**，漏掉它公式永远差 10px（实测长内容 `(116−91)/2=12.5`↔两侧 12px、短内容 `(116−67)/2=24.5`↔两侧 24px，完全吻合）。
- **采纳规则：对称双确认** —— 任何方向都要连续两次完全一致的读数。上一版「变大立即生效／变小两次确认」会让瞬时过大读数被永久锁死（实测 411）。
- 渲染层每 **500ms** 周期重测，提供「第二次读数」（内容不变时 `render()` 不重跑，否则永远等不到确认）。
- ⚠️ **改宽后必须 `sendState(target)` 把新几何推给渲染层**：渲染层用「窗口几何 + 禁区参数」换算禁区位置，拿旧几何会把禁区算偏（实测 `zone.x` 不随 W 变化 → 误判越界 → 右瓣被兜底裁掉 → 数字压进禁区带）。以前细条宽度恒定，这条推送缺失一直没暴露。
- 兜底裁切 `guardNotchContent` 的判据从「slot 边界」放宽到「**禁区本体**」：slot 只是期望空隙；按 slot 裁会裁掉完全正常的内容，并形成「裁切 → 上报变小 → 窗口更窄 → 裁更多」的崩缩正反馈。渲染层同时上报 `guarded`，主进程遇到被裁的那一帧读数一律不采纳。
- 范围：**只作用于 `strip`**（`expanded`/通知/大窗口/计时坞几何一律不动）；额度下限 24、上限 340。

**证据**：
- `--test` 新增两条不变量断言：`T29 细条宽度自适应`（窗口宽 = 两瓣+2×间距+空隙、两侧空白 ≤2px、无兜底裁切）、`T29 细条自适应已收敛`（连采 3 次宽度一致，防振荡）。
- T29 命中区域、T30 两条原先写死 `229/116` 的断言改成**实时期望 + 轮询去竞态**。
- 自检 **PASS 307 / FAIL 0 / TEST_OK**（日志 `shots/test-stripfit2.log`）。
- 临时量尺 `--diag-stripfit` 验证后已删除（原则 9）；结论固化在断言里。边界实测：长内容 204、短内容 180、超长 206（`.s-name` 有 4.2em 截断规则）、最短 168，长↔短来回 5 次每次都收敛且不越界。

### 同批修的两件事（2026-09-26）

1. **两侧留白 6px**：额度里加 `2×STRIP_SIDE_PAD`。断言用 `stripFit().pad` **实时读**，不写死像素（自检里实测空白 6/6，W=216）。
2. **盖板挡住交互**（`src/renderer/sensor/sensor.js`）—— 盖板窗口**不穿透**（`setIgnoreMouseEvents(false)`），所以它必须自己转发手势；旧实现只做了长按，而且起点有 bug：
   - 旧代码把起点惰性记在 `document._sx` 上、**从不清**：第二次以后的长按会拿**上一次手势的起点**比较 → 手指微动 8px 就误取消长按 = 用户报的「长按盖板没反应」。**起点必须在 pointerdown 重置**（照灵动岛的写法）。
   - 补上 `gesture` / `tap` / `doubleTap` 转发（`cover.action` → `island.onAction`）：盖板上由此**下滑放大、上滑收起、单击收起、双击开配置**，与灵动岛完全一致。
   - 盖板只有 87×26，指针很快移出窗口 → 必须 `setPointerCapture`，否则收不到 move/up。
   - 反馈：盖板 `.pressing` 1.06 → **1.12**（用户明确「不要发光」，只放大）；并新增 `cover:press` → `island.setPressFeedback()` → `'island:press'` → 渲染层 `pressFeedback()`，让**灵动岛本体同步**显示按下（视线通常落在岛上）。
   - 验证：临时 `--diag-cover` 用**真实鼠标事件**打在盖板窗口上，8 项全绿（长按→dock、下滑→zoom、单击→strip、两侧留白 6/6、岛同步反馈、长按岛本体对照没坏）；自检 **PASS 308 / FAIL 0**。

### 同批第二批（2026-09-26 晚）

1. **两侧留白 6 → 10px**（用户指定）：常量 `STRIP_SIDE_PAD`（`island.js` 顶部）。自检实测两侧空白 10/10、`W=224`。
2. **细条宽度对账（修掉一个真缺陷）**：采纳新额度时若正好有 `animateBounds` 在跑，**动画帧会把窗口写回上一个目标宽度**（实测 `pillSize` 说 216、窗口却停在 245，差 13px 且不收敛）→ 用户会看到两侧留白忽多忽少。修法：`tick()` 里加一次对账（仅 `strip` + 已采纳 + 非拖拽非动画），不一致就 `applyBoundsNow()`（不走动画、重算区域、推几何）。**自检能抓到它**（T29 命中区域那条断言）。
3. **删除「顶部进度条」与「右上角卡片」两个全屏展示形态**（用户指定）：牵连 7 个文件 —— `main/island.js`（decideState/几何/区域/穿透/透明度）、`main/sensors.js`（pickLayout 特例）、`main/settings.js`、`renderer/island/island.js`（DOM 分支 + `progressPercent`/`cornerClipPath`/`applyCornerClip` 三个函数）、`renderer/island/island.css`（两套重复样式）、`config/index.html` + `config.js`（选项 + 透明度滑块 + 进度条参数）、`main/main.js`（T24/T29/T34 断言）。
   - `fullscreenMode` 只留 **`hide`（默认）/ `strip`**；配置页那一项只剩两个选项。
   - **版本链新增 `to: 2`**：旧配置的 `progress`/`corner` → `strip`，并清掉 `progressTotalDays`、`smart.fullscreenState`、`opacity.corner`、`opacity.progress`（`SCHEMA_VERSION` 1 → 2）。这正是版本链的第一次真实使用，自检里用纯函数断言覆盖。
   - `grep` 复查：除**迁移链与验证旧值落位的断言**外，`src/` 里这两个词归零。
4. **游标尺划到头不再画刻度**：`rulerRender()` 的 `from` 从 `Math.floor(rulerStep - span)` 改成 `Math.max(P_MIN, …)`。不到底时继续往左画，那些格数会被 `rulerSeconds` **全压成同一个 5 秒** → 一排纹丝不动的刻度，看着像卡住。现在左端停在指针处（下界那一格），空白本身就是「到头了」的提示。自检：`刻度数=13 最左=174 指针=174 下界格=-27.5`。

5. **游标尺：纯线性 + 6 小时上限 + 「自定义」入口**（用户指定）
   - **删掉对数段**（`RULER_RATIO` 与 `rulerStepOf/rulerSeconds` 的第三段）；线性段步长 2 分钟 → **5 分钟/格**。理由：每格 2 分钟时到 6h 要滑 **2872px**，根本拖不到，「自定义」入口等于永远出不来；现在 1152px。
   - `setRulerStep` 加上界 `P_AT_6H`（6 小时）；惯性到边界**立刻停**（刻度不动了还让速度衰减，看起来就是卡住）。
   - **惯性改成恒定减速度**（用户要求「固定加速度」）：`INERTIA_V_MAX = 26` px/帧、`INERTIA_DECEL = 1.2` px/帧² → 滑行距离 = v²/(2a)，满速约 280px（旧版指数衰减 ×0.90 + 初速限 14，只滑 ~126px）。
   - 6 小时处出现「自定义…」chip → 点开变**分钟输入框**（回车 / 确定 / 失焦确认），上限 **24 小时**；输入值直接写进 `pickSeconds`（**不碰刻度**），所以 `timerStart` 与盖板显示天然生效。主进程 `dockPick` / `timerStart` 的上限同步为 24 小时。
   - ⚠️ **踩到的坑**：`.dk-custom-input { display: flex }` 与 UA 的 `[hidden] { display: none }` **特异性相同、作者样式胜出** → `hidden` 失效（输入框一直占位，把创建页可见刻度从 13 挤到 6）。必须补 `.dk-custom-input[hidden], .dk-chip[hidden] { display: none !important; }`。自检那条「创建页按钮集合」断言也改成**只数真正可见的元素**（`getClientRects().length > 0`）。
   - 断言：原「可无限拖拽（无上限）」→「刻度上限 6 小时（拖到头即停）」；新增「到 6 小时出现自定义入口 → 输入 500 分钟 → 标签 `8 小时 20 分` 且主进程选中 30000 秒」。

## 三·补 · 发布链路的两个坑（2026-09-26 实测，先看这段再发版）

1. **`.github/workflows/release.yml` 一直是「未提交」状态** —— 远端仓库的 Actions 里 `workflows=0`、`runs=0`，也就是说 **CI 发布链一次都没跑过**；v3.1.0 当初是手工发的（`release.yml` 里那段注释描述的正是手工方式的痛点）。
   → 想用 CI，必须先把该文件推到**默认分支**（GitHub 需要 workflow 出现在默认分支才会注册与触发）。
2. **远端 main 是用 GitHub API 造的提交**（历史里有 `scripts: git-push-api 支持指定远端父提交`），所以同一个 v3.1.0 在本地与远端 **SHA 不同** → 本地 `git push origin main` 被拒（非 fast-forward）。已核对 **内容是同一棵树**（`git diff origin/main 435f5d7~1` 为空），合并/重置都不会丢东西。

**本次实际状态**：tag `v3.2.0` **已推到远端**（指向本地提交 `435f5d7`），但因为没有 workflow 注册 → **没有触发任何构建**；GitHub 上最新 Release 仍是 v3.1.0。

**建议的修法（涉及改远端 ref，必须经用户同意）**：
```bash
# 1) 把 v3.2.0 接到远端 main 上（线性历史，内容不丢）
git tag -d v3.2.0 && git push origin :refs/tags/v3.2.0   # 先撤掉那个「孤儿 tag」
git reset --soft origin/main && git commit -m 'v3.2.0: ...'
# 2) 推 main（这次是 fast-forward）+ 重打 tag 并推 → 触发 CI
git push origin main && git tag -a v3.2.0 -m 'Smart Counter Island 3.2.0' && git push origin v3.2.0
```
或者：只推 main，然后在网页 Actions 里手动 `Run workflow`（输入 `v3.2.0`）。

6. **第三批（同日）**
   - 计时坞左侧选中时间改成**固定宽度**（`width: 136px`）：原先用 `min-width`，文字一长（「15 分钟」→「8 小时 20 分」）就把刻度条挤窄、中间那条绿色指示线跟着跑。
   - **删掉「自动放大门槛」`smart.zoomIdleSec`**，与 `expandIdleSec` 合并成一个值（**默认仍是 0 = 不自动放大**）；`decideState` 只看 `expandIdleSec`；**版本链 to:3** 负责迁移（旧配置启用过就把等待时长并过去，等价于原 `max(expandIdleSec, zoomIdleSec)`）。`SCHEMA_VERSION` 2 → 3。
   - `glEdgeGlow`（边缘高光强度）默认 **100 → 5**。
   - 事件面板：去掉「图标」「强调色」输入（内部 `editorMeta` 保留原值/给默认），「名称」改「**简称**」；新增「**高考 / 中考**」一键预设（6-7 / 6-13，日期过了取明年）。
   - 自检里写死的 `schemaVersion === 2` 改成实时读 `settings.SCHEMA_VERSION` —— 这次版本号一升就把这处写死暴露了。
   - 自检 311 项全绿。

7. **第四批（2026-09-27）：用户报的三个体验问题**
   - **细条文字「莫名其妙闪一下」**：根因不在细条逻辑，而在 `island.css` 的入场动画 ——
     `body[data-notch="1"] #content > * { animation: sci-content-in 0.3s ease-out both }`（淡入 + 上移 4px）
     挂在**节点**上，而细条 `render()` 每次都整块 `box.innerHTML = …`；节点一换动画就重播。
     触发源根本无所谓（宽度对账、天气 chip 刷新、轮播切事件、主进程任何一次状态推送都算）。
     修法两处互补：① 动画改成**只在形态切换时**播（`onState` 里 state 真变了才给 `#content` 挂 `.in-anim`，
     `animationend` / 400ms 兜底摘掉；选择器收窄成 `#content.in-anim > *`）；② 细条加**内容签名**，
     签名一致就不写 `innerHTML`（照计时坞 `lastDockSig` 的做法）。
   - **大窗口玻璃特效「要调整两次才出现」**：玻璃有一条「动画期间隐藏、等主进程推新截图再显示」的门
     （`glassWaiting`）。而 `applyBoundsNow()`（立即改尺寸、**没有动画**）以前也发 `island:anim {on:false}`，
     渲染层据此进入等新图 —— 可这条路径**从来不抓新图**，于是玻璃最长空 800ms（靠兜底定时器才回来）。
     用户恰好那一刻进大窗口，看到的就是「第一次只有模糊底、没有折射/边缘高光」。
     修法三处：① `applyBoundsNow` 改发 `{ on:false, instant:true }`，渲染层带 instant 就不进等新图；
     ② `onGlass` 收到新图后**无条件**重估（旧代码只在 `glassWaiting` 时重估 → 滤镜会停在上一份几何上）；
     ③ 细条签名把**窗口尺寸**也算进去（见下方坑）。
   - 新增 **T39**（5 条断言）：细条重复推状态不重建 DOM、状态不变不挂入场动画、形态切换才播且会摘掉、
     大窗口**首次**进入即挂 `lg-filter`、立即改尺寸不进入等新图。
   - **白边（背景近黑时那 1px 描边）跟随背景明暗太慢**：亮度靠截屏采样，细条还有 ×1.6 倍率 →
     2.56 秒才采一次，用户切到黑色 PPT / 切回桌面时白边要两秒多才跟上。
     **实测一次截屏 ~175ms 且与缩略图大小无关**（480×270 = 177/183/185…ms，1920×1080 = 172ms，
     成本全在采集服务）→ 靠"提高采样频率"提速等于让采集管线 1/3 时间在抓屏，不可取。
     改成**事件触发**：`tick()` 本来就有前台窗口探针（pid/class），一变就立刻补一次亮度采样 →
     切 PPT / 切应用 / 回桌面的响应从 2.5s 降到 ~0.4s，常态开销不变。新增 **T40**（3 条断言：
     切换补采 / 同前台不重抓 / 800ms 内再切换不补采 + GPU 模式不补采）。
   - **白边口径改成"贴脸"**（用户要求）：① 采样区域从**整个窗口**（含四周 PAD 透明留白，会把背景
     稀释掉）改成**胶囊那块**（`pillRectOnScreen()`，尺寸取自 `pillSize`，与窗口尺寸同源）；
     ② 判据从「平均亮度 < 0.15」改成「**近黑像素占比** ≥ 0.6 加 / ≤ 0.4 撤」—— 小岛压在明暗交界处时
     平均值会卡在滞回带里，白边既不出现也不消失（用户说的"没反应"）。CPU（主进程截屏）与 GPU
     （渲染层视频流）两条链路都改了，`island:brightness` 现在同时下发 `brightness` 与 `darkRatio`。
     新增 **T41**（5 条断言：只采胶囊 / 全黑 / 全白 / 各半落滞回带 / 七成近黑但平均不亮仍判暗）。
   - **自检时桌宠窗口不可见**：`quiet` 设的 `setOpacity(0)` 会被 `pet.applySettings()` 里的
     `win.setOpacity(c.opacity)` 覆盖 → 跑一次自检用户桌面上就冒出一只本该暂停的桌宠。改成统一走
     `quiet.setOpacity()`（安静模式下恒为 0），T27 加守门断言。
   - 自检收尾改成 `finishTest()`（停采集 → 等在飞截屏 → 关岛/桌宠/配置页/玻璃实验室 → 退出）：
     直接 `app.exit()` 硬杀会把系统 DXGI 复制留在坏状态（见下方坑）。
   - 自检 **325 项全绿**（`TEST_OK`，PASS 325 / FAIL 0，DXGI 失败 0）。

8. **第五批（2026-09-27）：教学助手（原「桌宠」）+ 素材库**
   - **更名**：用户可见文案「桌宠」→「**教学助手**」共 81 处（配置页/托盘/通知/素材包说明/README/FEATURES）。
     代码标识符仍叫 `pet`（`Pet` 类、`pet.js`、`pet-pack.js`）—— 只是内部代号，注释里已写明。
     ⚠️ 历史文档（`release-notes-*.md`、HANDOFF 里的旧段落）**保持原样**，那是当时的事实。
   - **解除暂停**：配置页原来是「整页灰置 + 不可交互 + 顶部提示」（`.pet-paused` / `.paused-note`），
     现已去掉（改名后的功能是要用的）。默认仍是「关」，老师自己开。
   - **包格式扩展**：精灵图写法加了两个可选字段 `start`（本动作第一格，0 基）与 `cells`（图集总格数，
     算行数用）—— 一张图集放多个动作用。渲染层 `drawSprite` 相应改（行数按 cells 算、索引从 start 起），
     向后兼容（不给这两个字段时行为与以前一致）。
   - **死字段复活**：渲染层 `P.packScale` 一直只存不用（素材包声明的自带比例）→ 现在真的参与缩放
     （`spriteScale() = 用户大小 × packScale% `）。192×208 一格的像素图集靠它声明"我本来就大"，
     用户不必为了换素材去手改大小。
   - **内置纳西妲**：`assets/pets/nahida--lingxiaotian/`（图集 2.4MB + pet.json + LICENSE.txt，署名 legeling，
     CC BY-NC 4.0）；`package.json` 的 `build.files` 加 `assets/**/*`；默认素材包优先用内置
     （`pet-pack.bundledDefaultPack()`），没有才回落 `<userData>/pets/示例`。
     行映射（官方 animation-rows.md，已用渲染层逐格采样核实）：idle→行0(6帧)、walk→行1(8帧)、
     talk→行3 挥手(4帧)、sleep→行6 等待(6帧)；v1=8×9/72 格、v2=8×11/88 格，前 9 行语义相同。
   - **素材库**（`src/main/pet-library.js` + 配置页列表）：清单随包发行（`assets/pets-catalog.json`，
     258 条 104KB，由 `scripts/gen-pet-catalog.mjs` 从仓库的 pets.json + install-manifest.json 合成），
     图集**按需下载**到 `<userData>/pets/<id>/`（sha256 校验、raw→jsDelivr 双源回退、自动生成
     本程序格式的 pet.json 与 LICENSE.txt）。列表支持搜索 / 单个下载 / 全部下载（约 500MB）/ 删除 / 使用。
     ⚠️ **为什么不内置全部**：258 个共 502MB，且 **33 个没标再分发许可**、另有一批写着"仅个人使用 /
     需授权" —— 随公开安装包分发有版权风险。清单在包里、素材在用户机器上，风险与体积都最小。
   - 新增 **T42**（6 条断言：内置包可读 / 行映射 / 署名带出 / 默认目录优先内置 / 清单条数与纳西妲在列 /
     下载校验与 v1-v2 格数 / 图集端到端逐格采样 / 配置页列表真渲染出 258 行）。自检 **333 项全绿**。

9. **第六批（2026-09-27）：行为系统重做**（用户报"光知道乱动、一直是同一帧、还会出屏幕"）
   - **一直是同一帧**（实现缺陷）：`pet.js` 的帧推进判据是 `s.frames.length > 1` —— 精灵图素材的
     `frames` 只有 **1 张图**（帧在图上按格切），于是永远停在第 0 帧。改成按 `frameCountOf()`
     （精灵图看 `sheet.count`）× 状态 fps 推进，换动作时把帧重置到 0。
   - **乱动**（设计缺陷）：`pet-brain` 旧公式里 seed 每秒都变 → 所谓"周期"根本不存在，每秒重掷；
     走动占 2/3、方向每拍重掷。重做成**带持续时长的状态机**：`nextAction(input, state)` 返回
     `{action, dir, until}`，`until` 之前保持不变；走动方向整段不变；走完一段**必先接 idle**；
     常态行为加权抽签（安静档 发呆 65 / 走 20 / 说话 8）；**睡觉不参与抽签**（只由
     `sinceInteractMs ≥ sleepSec` 触发，否则会上着课突然睡 2–4 分钟）。
   - **出屏幕**（实现缺陷）：活动范围写死 `pad=30`，与素材宽度无关 —— 192×208 一格的图集（scale 55% → 106 宽）
     可以走到 `x = w-30`，精灵右缘出画布/屏幕。改成按 `spriteBox()` 算半宽并**每帧重算**
     （只在 resize/走动时算会拿到换素材前的旧值：实测 36 vs 应有的 57）。到边界掉头。
   - **用满官方 9 行**：新增三个瞬态反应 jump(行4)/fail(行5)/review(行8)；`STATE_NAMES`、素材库 `ROWS`、
     内置纳西妲 pet.json 同步；缺行的素材自动回落 idle。
   - 坑：瞬态反应曾用 `performance.now()` 计时且只在 rAF 里撤销 —— 窗口被遮挡时 rAF 会停，反应永久挂着
     （实测 1.6s 后仍是 jump）。改成**墙钟 `Date.now()` + 读取时判过期**。
   - 坑：`--test-fast` 会把 `sleep` 按比例缩短，而瞬态反应按真实时间到期 —— 断言要**轮询到撤销**，
     不能按固定 sleep 判。新增 **T43**（4 条），改写 T26。自检 **340 项全绿**。

### 发布链路：一次真实的 CI 首发（2026-09-26，v3.2.0 已发出）

踩到并修好的四件事（**下次发版照这个顺序做**）：

1. **`release.yml` 必须先落到默认分支** —— 否则远端 Actions 里 `workflows=0`，推 tag 也不会有任何反应（本次是先推 main 再推 tag 才跑起来的）。
2. **`git push -f origin <tag>` 覆盖同名 tag 不会触发 workflow**（内容没变化时更不会）。要么删掉 tag 再推，要么用 **`workflow_dispatch` 手动触发**（workflow 里已留入口，`tag` 参数填版本号）—— 手动触发走 API：`POST /actions/workflows/release.yml/dispatches`，body `{"ref":"v3.2.0","inputs":{"tag":"v3.2.0"}}`。
3. **electron-builder 看到 tag 会自己去发布**（日志 `reason=tag is defined`），没有 `GH_TOKEN` 就直接报错退出（`⨯ GitHub Personal Access Token is not set`）—— 已在 `npm run dist` 的两条命令上加 **`-p never`**，发布只交给 workflow 里的 `action-gh-release`。
4. ⚠️ **本地的「干净自检」其实是老配置**：自检隔离目录里若没有 `settings.json`，`settings.js` 会从 `AppData\Roaming\LiquidGlassCounter\settings.json` **复制一份老配置**过来 —— 所以本地常年跑在「老配置」上，而 CI runner 上是**真·全新配置**。这次 CI 冲出来的三条失败有两条源于此：
   - `T9` 依赖「闲置后自动放大」（老配置里开着；新默认 `expandIdleSec: 0` 是关的）→ 夹具改成**显式开启**并在结束时恢复；
   - `T29 细条白字` 写死「RGB > 180」（老配置 `opacity.strip = 1` 能过；全新配置默认 **0.6**、白字合成后最亮只有 ~92）→ 改成**有效亮度**（把窗口透明度乘进去）并按**实测**取阈值 60。
   - **本地复现 CI 的正确姿势**：`$env:SCI_USER_DATA=<某空目录>`，并且**在该目录里放一个内容为 `{}` 的 settings.json**（只给空目录是不够的 —— 那样又会去复制老配置）。
   - CI 闸门里也把 `T29 细条白字` 归入「环境不可验证」（runner 无真实显示器/GPU 时截图可能全黑）；但它本身已被修得更稳。

**本次结果**：`run 36250715534` push → success；Release <https://github.com/SenbonFanKageyoshi/smart-counter-island/releases/tag/v3.2.0>（Setup 71.3 MB / portable 71.1 MB）。

**历史四次失败（别再走一遍）**：①怪测量口径 ②怪 DOM 结构（已证伪）③定位到「测量滞后」但对（方案 A 仍溢出）④护栏方向不对称（锁死 411）。真正的靶子是三者叠加：**测量滞后 + 改宽不推几何 + 兜底裁切判据过严**。

---

## 四、这片代码里几个容易踩的坑（都是这轮踩过的）

- **盖板是永久置顶的独立窗口**，实测压在灵动岛窗口顶部正中（`87×26@916,11` vs `576×195@672,0`）。**任何居中布局都可能把内容送进它底下**——创建页顶部那 52px 留白就是为此。
- **改 DOM 元素必须同时删监听器**：删了 `#buttons` 元素却留着 `$('#buttons').addEventListener`，页面一加载就抛异常（无语法错，最难查）。
- **脚本化文本片段替换会翻车**：空白/引号稍微不一致就静默不匹配；`node -e` 里的引号还会被 bash 吃掉（`require('./holiday')` → `require(./holiday)`）。**改结构用 `read` + 精确 `edit`；批量改名才用脚本。**
- **`deepseek` 风格的回退要先量再改**：这轮"盖板挡文字""游标尺刻度""惯性过头"三次都是我猜错、量了才对。
- **测试跑在真窗口上**：`src/main/quiet.js` 会在 `--test` / `--diag-*` / `--shot*` 下把窗口设成不可见（`setOpacity(0)`，**不能用 `show:false`**，否则布局/截图全坏）。
- **发布链路已搬到 CI**：推 `v*` tag 即可，**不要再手动贴 token**（上一轮 token 因此泄在了对话记录里）。
- **「内容签名防重建」必须把窗口尺寸也算进签名**：细条加签名跳过重建后，`T29 split 两瓣永不压缩` 立刻红 ——
  右瓣被压成 0 宽。原因是重建顺带**清掉了上一轮「兜底裁切」留在节点上的 `maxWidth`**，让两瓣按新几何重量一次；
  只比内容 HTML 会把这个裁切状态一直留着。签名 = 内容 + `innerWidth`×`innerHeight` 才对。
- **自检不要直接 `app.exit()` 硬杀**：它跳过 before-quit，采集会话来不及释放 —— 实测把系统的
  DXGI 桌面复制留在坏状态：之后**任何**进程的 `desktopCapturer` 从启动就失败并掉到 670~930ms 的慢路径
  （正常 ~175ms），GPU 玻璃那四条（T18/T21/T22/T23）跟着全红，而且**看起来像代码回归**（我第一次就误判了）。
  判据：日志里**首次 DXGI 失败的行号**若远早于 GPU 断言（如第 44 行 vs 第 264 行），就是环境而不是代码；
  再独立跑一个小程序做 `getSources` 对比耗时即可确认。自检收尾已改成 `finishTest()`（停采集 → 等在飞
  截屏 → 关窗口 → 退出）。
- **下载素材必须用 Electron 的 `net.fetch`，别用 Node 全局 fetch**：本机（国内网络 + 本地代理）把
  `raw.githubusercontent.com` 和 `api.github.com` 都解析到 **127.0.0.1**，由代理接管 —— Chromium 那条路
  （`net.fetch`，跟随系统代理/PAC）能下，Node 的 `fetch` 直连 → `fetch failed`。所以 `pet-library.js` 走
  `net.fetch`，并配 8 个源的**回退链**（raw / jsDelivr 三域名 / ghproxy 三个 / statically），成功后把源序号
  写进 `<userData>/pets/.source`，下次启动直接用它（被墙的源只白等一次）。批量下载连续失败 3 个就中止，
  不让用户对着 258 个素材干等。
  实测：raw 被挡 → `cdn.jsdelivr.net` 命中。**全量下载 258 个素材已跑通**：0 失败、797 秒（约 13 分钟）、
  落盘 0.49 GB 到 `%APPDATA%\LiquidGlassCounter\pets\`（每个目录 = spritesheet.webp + pet.json + LICENSE.txt）。
  源记忆（`.source`）修好后的实测：首次 31s（raw 吊满超时）→ 第二个素材 **826ms**（粘住 jsDelivr，快 38 倍）；
  ⚠️ `loadSticky` 必须**无论文件是否存在都先记住路径**，否则 `saveSticky` 无处可写、记忆永远不生效。
- **截屏一次约 175ms，且与缩略图大小无关**（实测 480×270 = 177/183/185…ms、1920×1080 = 172ms）：
  成本在 `desktopCapturer` 的采集服务本身。任何「让某个视觉跟随背景更快」的想法先量这个数 ——
  提频是线性涨占用（细条 2.56s 一次已是常态开销的主要来源），正确做法是**事件触发**。
- **入场动画属于「形态」，不属于「节点」**：动画只要挂在 `#content > *` 这类会被重建的节点上，
  任何重建都会重播。反过来用「形态切换」当触发条件时，**测试不能按固定时刻单点采样**：
  切换初期 tick 可能把状态拉回再进（那也是一次形态切换，动画本该重播）→ 断言要写成「轮询到某个
  仍处于目标形态、且动画已摘掉」的采样点。

---

## 五、常用命令

```bash
# 自检（约 4 分钟；需要正常桌面/非受限环境 —— 受限沙箱下 electron 建不出窗口进程）
./node_modules/electron/dist/electron.exe . --test --test-fast

# 真实输入诊断（长按 1s 真鼠标事件 + 截图到 shots/）
./node_modules/electron/dist/electron.exe . --diag-press

# 配置页逐 tab 截图到 shots/
./node_modules/electron/dist/electron.exe . --shot-config

# 打包（先确认没有 SmartCounterIsland 进程占着 exe，否则便携版会 Can't open output file）
npm.cmd run dist
```

**注意**：`node` 在 Git Bash 里有时会解析到 DSH 自带的 stub 而报 `This: command not found`；用 `node -e` 正常，但别包 `timeout`。PowerShell 里直接 `node` 没问题。

---

## 六、2026-09-26：工程债第 1、2 项的做法与证据（给下一个会话）

### 第 1 项 · 删除 `decideState` 的死参数 `expandedSinceMs`
- **事实**：`expandedSinceMs` 被解构但函数体从未读它；`this.expandedAt` 全仓只有 1 个读者（第 1451 行那行实参）→ 二者可连根删。
- **改了 9 处位置（10 次精确编辑，含一条 JSDoc 注释）**：`island.js` 5 处（158 解构 / 1451 实参 / 255 初值 / 1051 `setState` 赋值 / 2247 `create()` 赋值，连带一条已写错的注释）；`main.js` 4 处（3 组测试夹具的 `expandedSinceMs: 0`、T9 夹具的 `island.expandedAt = …`，连带其 JSDoc）。
- **`'expanded'` 状态本身保留**（20 处测试在用，属第 6 项）。
- **证据**：`node --check` 通过；全仓 grep `expandedSinceMs|expandedAt` 只剩本文档这句；自检 305 项全绿。

### 第 2 项 · `settings.js` 的 `schemaVersion` 版本链
- **落盘键**：`schemaVersion`（当前 `1`）。旧 `version: 3` 是僵尸字段（全仓无人读，而真机磁盘上写的是 2）→ 已废弃并从配置里清掉。
- **语义**：磁盘上没有 `schemaVersion`（v3.1.0 及以前）一律当作 **0 → 完整跑一遍链**，与改造前「无条件跑全部散装迁移」逐字节等价；磁盘版本比代码新（降级运行）→ 整链跳过、不回写。
- **分工**：① `MIGRATIONS`（`to: 1`）= 一次性历史迁移；② `load()` 后半段 = 每次加载都必须做的兜底（`events` 首次示例/非数组、事件 `id` 补全、课表 `weeks/cycleWeeks/restWeek`）——**别把兜底塞进链里**，那会让第二次启动起失效。
- **加新迁移的姿势**：`SCHEMA_VERSION` 加 1，并在 `MIGRATIONS` 末尾追加 `{ to: N, run(disk, cache) }`；`run` 里判据只看 `disk`（「这个旧键真写过吗」），改动落在 `cache`，返回是否改动。**每一级必须幂等**（同一份数据跑两遍结果一致）。
- **踩到的坑（对照实验抓出来的）**：`deepMerge` 会把磁盘上的**多余键原样保留**，所以「从 DEFAULTS 删掉一个键」不等于「配置里不再有它」—— 废弃键必须在链里显式 `delete`（`version` 就是这样漏掉又补上的）。
- **附带发现（未改行为，只在链里加了注释）**：4 条散装迁移**实际不可达**（判据恒假，因为 DEFAULTS 已含同名键）：`ui.positions.bar`、`ui.opacity.bar`、`ui.opacity.compact`、`ui.opacity.corner/progress` 补默认。
- **证据**：临时脚手架 26 项断言全绿（6 组历史形态：v1 形态含 `version:2`、`hideOnFullscreen`、`corner/dock/桌宠/废弃键`、空磁盘、坏数据、已是当前版本）；每组**跑两遍幂等**；与 `git show HEAD:src/main/settings.js` 的旧实现对同一组老配置**逐字节一致**；真实 `%APPDATA%\SmartCounterIsland\settings.json` 副本除 `version:2 → schemaVersion:1` 外**逐字节一致**；自检 PASS 305 / FAIL 0。脚手架已按原则 9 删除。
- **顺带观察**：自检用隔离 userData，但若隔离目录里没有 settings.json，`settings.js` 会从旧目录 `Roaming\LiquidGlassCounter\settings.json` 复制一份真实旧配置 —— 等于每次自检都顺带验一遍真实旧数据的迁移链。

### 还没做
- 第 3 项（断言改成测不变量）**未动**。
- 细条宽度自适应**一行未碰**（见第三节）。
