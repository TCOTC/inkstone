# AGENTS.md

AI 协作者的工程约定。**这份文件只放开发流程**（怎么构建、怎么测、代码放哪儿、边界在哪）；
功能清单与架构约束在 `docs/design.md`。

> 改动功能时不要顺手改这份文件。只有「团队怎么工作」变了（命令、构建工具、目录约定、测试方式）才动这里。

## 这个项目是什么

Chrome 扩展：在网页划选文字做高亮、翻译、解释。
纯本地、无账号、无自建服务（AI 请求直连 DeepSeek，同步走 Chrome 自带账号）。

## 技术栈与硬约束

| 项 | 值 |
| --- | --- |
| 目标浏览器 | **仅 Chrome**，最低 130（`storage.local.getKeys`） |
| 构建工具 | `extension` **4.1.30**（精确版本，勿升级） |
| Node | >= 26.12（`node --test` 直接跑 TypeScript） |
| 包管理器 | pnpm |
| 语言 | TypeScript，`strict` + `noUnusedLocals` + `noUncheckedIndexedAccess` |
| TypeScript | **6.0.3**。`vue-tsc` 依赖 `lib/tsc`，TS 7 的原生端口没有它 |
| 界面 | **仅管理页**用 Vue 3.5 SFC（`src/app/*.vue`）；content script 保持纯 DOM |
| API 风格 | 直接用 `chrome.*`，MV3 原生返回 Promise；不引 polyfill |
| 清单来源 | `src/manifest.json`（不放到 `public/`） |
| 构建产物 | `dist/chrome/`（由 `extension.config.js` 锁定） |

用到更新的 Chrome API 时同步抬高最低版本 + 改 `tools/verify-build.mjs`。
`extension-env.d.ts` 由构建自动生成且已 gitignore：**不手写、不提交**。

## 常用命令

```bash
pnpm build        # 生产构建 → dist/chrome/
pnpm dev          # 不混淆的开发构建（权限与生产一致）
pnpm watch        # 监视 src/，改完自动重建
pnpm typecheck    # 需先 build（chrome 类型来自生成的 extension-env.d.ts）
pnpm test         # 单元测试（node:test，无第三方依赖）
pnpm verify       # 产物自检（权限、入口文件、host 权限、中文编码、测试文件泄漏）
pnpm icons        # 重新生成占位图标
node tools/extension-id.mjs   # 当前产物的扩展 ID
```

四条自定义脚本都从**仓库根**解析路径，从任何目录调都能跑（不必先 `cd`）。

`watch` / `dev` **只构建**，不启浏览器、无热重载。重建后到 `chrome://extensions` 点刷新。
不给 `extension dev` / `start` / `preview` 加脚本：它们会下载独立 Chrome for Testing，
并产出带额外权限的开发版清单。

## 目录结构

```
src/
├─ manifest.json        清单来源
├─ background.ts       工具栏图标入口、菜单、AI 转发、全量同步
├─ content/            ← 页面内，纯 DOM：入口 / 渲染 / 浮层 / 导航
│  ├─ index.ts          调度：读划线 → 重定位 → 渲染 → 事件绑定 → 脱钩降级
│  ├─ highlighter.ts    CSS Custom Highlight 渲染 + 命中检测
│  ├─ toolbar.ts        划词 / 点划线的工具条
│  ├─ toolbarMetrics.ts 工具条盒模型的唯一数据源
│  ├─ markers.ts        右侧标记点条与悬停列表
│  ├─ pagePanel.ts      本页划线面板（含未定位分区）
│  ├─ spotlight.ts      跳转后的描边框
│  ├─ aiCard.ts         AI 结果卡片
│  ├─ aiCards.ts        多卡片生命周期
│  ├─ markdownRender.ts Markdown → DOM（零 innerHTML）
│  ├─ geometry.ts       浮层坐标纯函数
│  ├─ selectionContext.ts 选区前后文的 DOM 遍历
│  ├─ userSelect.ts     按需解除站点的 user-select: none
│  └─ extensionAlive.ts 扩展更新后本页脚本的存活判定
├─ app/                 管理页的 Vue 视图（只被打进 options 文档）
│  ├─ App.vue + App{Highlight,Ai,Data}.vue
│  ├─ settingsStore.ts  设置状态（乐观写盘 + 统一保存反馈）
│  ├─ usePrompts.ts     提示词草稿与校验
│  ├─ Library.vue       我的划线
│  └─ theme.css         共用色彩变量与按钮底座
├─ pages/               构建工具打包的 HTML 入口与页面样式
├─ shared/              纯逻辑：存储 / 编解码 / 备份 / 定位 / 同步 / 样式
│  ├─ textIndex.ts      坐标系（正文文本节点 → 去空白字符串）
│  ├─ anchor.ts         创建锚定：选区 → 三元组
│  ├─ relocate.ts       回放重定位：三元组 → 落点 + 错误码
│  ├─ db.ts / lock.ts   存储访问 / 页级写互斥
│  ├─ sync.ts / merge.ts / tombstones.ts   跨设备同步
│  ├─ ai.ts / sse.ts / aiKey.ts / prompt.ts / markdown.ts   AI 相关
│  └─ indexFixture.ts / storageFixture.ts  仅测试用的替身
└─ images/              生成的占位图标
tools/                  构建与自检脚本（.mjs）
docs/
├─ design.md            功能清单与长期架构约束
├─ identity.md          扩展 ID 与数据归属
├─ TODO.md
└─ initial-highlights.json  回放基准，首个备份
```

`src/**` 下与源码同级的 `*.test.ts` 是那个模块的 `node:test` 用例，不逐条列出。

## 五条必须知道的边界

1. **数据存 `chrome.storage.local`，一页一个键**（`p:` + `pageKey(url)`）。
   storage 对 content script 直接可见，所以划线的读 / 增 / 删在 content script 里直接调
   `shared/db.ts`，**不经 background 转发**。`storage.sync` 只是通道，**权威永远是 local**；
   任何「收到远端数据就覆盖」的写法都会丢线（合并规则的由来见 `docs/design.md` §4.7）。
2. **定位算法只有一份**：`shared/textIndex.ts` + `anchor.ts` + `relocate.ts`。
   content / 管理页都不许自己写「找一下这段文字」，也不许改降级顺序。
3. **`prev` / `next` 保留原始空白**：比对前才 `stripWs`。不要「顺手规范化」存进去的值——
   空白本身是锚定信息的一部分，而它们是同句多次出现时唯一的消歧手段。
4. **页面键只在 `shared/url.ts` 里算。** `pageKey` 只做不改变语义的规范化；删追踪参数只在
   `looseKey` 里做，且只用于回退匹配，**永远不写进键**。不要加「去尾斜杠 / 强制 https / 删 www.」
   这类合并。
5. **构建工具会重排产物路径**：`src/pages/app.html` → `options/index.html`，
   content script → `content_scripts/content-0.js`。改入口后必须同步 `tools/verify-build.mjs`。
   只有清单里声明的页面角色才会被打包，所以两个管理视图共用一个 HTML。

## 工程约定

1. **权限最小化**：`storage` + `contextMenus`，host 权限只有 AI 接口一个域名。加权限 → 同步
   `docs/design.md` 的权限表 + `tools/verify-build.mjs`。页面注入由 `content_scripts.matches` 声明，
   不需要 `scripting`。
2. **只用 `chrome.*`**：不引 `browser.*`、不引 polyfill。
3. **同一件事只写一处**：颜色在 `shared/colors.ts`；画笔样式在 `shared/styles.ts`；
   URL 归一化在 `shared/url.ts`；存储键名与备份格式在 `shared/rowCodec.ts`；
   工具条盒模型在 `content/toolbarMetrics.ts`。
4. **测试只用 `node:test`**，不引 vitest / jsdom。DOM 相关算法通过 `IndexLike` 注入纯文本替身
   （`shared/indexFixture.ts`），测试里不必造 DOM。`noUncheckedIndexedAccess` 下取数组元素
   先判空或用 `?? 默认值`，不要用 `!` 吞掉假设。
5. **界面层没有单元测试**：管理页与浮层的唯一验证是装进 `chrome://extensions` 手点。
   例外是抽出来的纯逻辑（`markerLayout` / `highlightPlan` / `geometry` / `toolbarMetrics` /
   `markerEntries` 等都有 `.test.ts`）。新增交互时把「该显示什么 / 该怎么排」的决策抽成纯函数去测，
   DOM 那层只做执行。涉及定位的改动必须先补 `relocate.test.ts` / `anchor.test.ts` 的用例。
6. **Vue 只在管理页**（`src/app/*.vue`，由 `src/pages/app.ts` 挂载）；`src/content/**` 保持纯 DOM。
   两个硬理由：content script 是全站注入的单文件入口，Vue runtime 会摊到每个页面；
   而 SFC 的 `<style>` 只会进页面文档，进不了浮层的 Shadow DOM。
   不引 `vue-router` / Pinia：两个视图靠 hash 分发，状态在 `storage.local`。
   组件里不写 `<style>`，样式留在 `theme.css` / `app.css` / `library.css`。
7. **仓库要能在任何机器上直接跑**。这个项目不绑定某台电脑：
   - 脚本的路径以**仓库根**为基准（`dirname(fileURLToPath(import.meta.url))`），不依赖当前工作目录；
   - 不往代码、文档、注释里写本机绝对路径或“我这台机器”的观测记录；
   - 行尾由 `.gitattributes` 固定成 LF（`* text=auto eol=lf`，入库与检出都是 LF）；
   - 开发版 ID 随**加载路径**变，换目录 / 换机器就是一份新的 `storage`（见 `docs/identity.md`）。

## 提交前自检

```bash
pnpm test && pnpm build && pnpm typecheck && pnpm verify
```

`build` 必须排在 `typecheck` 前：`extension-env.d.ts`（`chrome` 全局类型与 `*.css` 模块声明）
由构建生成且不入库。新 clone 直接 `pnpm typecheck` 会报一堆 `Cannot find name 'chrome'`。

## 提交消息

**只写一行主题，简洁优先。**

- 一句话说清「改了什么」，祈使/陈述都可以，**不加句号**，一般不超过 50 字。
- 前缀（`feat:` / `fix:` / `chore:`）和分类标签**都不要**：只有一条主线时它们是噪音。
- 正文只在「为什么」无法从 diff 看出时才写，同样一句话说完；不要复述改了哪些文件、
  不要贴代码、不要写「此提交…」。

## 调试要点

- **先分清「定位错」还是「渲染丢了」**：定位失败会进「未定位」清单（带 `errCode`）；
  定位成功但页面没颜色，才是渲染层（`CSS.highlights` 注册名 / `::highlight()` 样式）的问题。
  旁证：能点出浮层说明 `Range` 在，只是样式没生效。
- **未定位清单有两处入口**：左键点图标打开的页面右侧面板底部，以及「我的划线」左列顶部的
  「未定位」项。两处都只列原文，`errCode` 只挂在该行的 `title` 里。
  近似命中**不在**这个清单里（它是成功定位，只是样式更淡、列表里带标注）。
- **改完必须重开页面**：content script 只在页面加载时注入一次。
- **页面里选不中文字 → 先查 `user-select`**：站点设为 `none` 时浏览器不产生选区。
  这只影响「划新划线」，回放 / 查看 / hover 都照常。
- **两个扩展页面是同一个文档**：`options/index.html` 与 `options/index.html#library`。
  偏好设置内部再分三组（`#settings/highlight|ai|data`），**切组用 `history.replaceState`**：
  改 `location.hash` 会触发 hashchange，整个视图被卸载重建，输入框会丢焦点。
