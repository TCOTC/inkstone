# Inkstone

在网页划选文字做高亮、翻译、解释。

纯本地、无账号、无自建服务：划线存在 `chrome.storage.local`，AI 请求直连 DeepSeek，同步走 Chrome 自带的账号同步。

## 安装（开发版）

```bash
pnpm install
pnpm build
```

打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选 `dist/chrome`。
改完代码要重新 build 并在扩展页点刷新，再重开要用的网页。

## 能做什么

- 划选文字做高亮；点已有划线可删除、复制
- 页面右键菜单可复制当前页的标题和链接（文本或 Markdown）；选中文字后右键，菜单变成「复制选中文本和链接」
- 正文被改过一两个字时按「近似」重定位并标注；定位失败的不丢弃，进「未定位」清单可逐条核对
- 翻译 / 解释：划选或点划线后发请求，流式显示，可按需联网搜索
- 本页列表（点工具栏图标）、右侧标记点、跨页的「我的划线」
- 导出入 JSON 备份；跨设备同步默认关闭

## 隐私与权限

| 权限 | 用途 |
| --- | --- |
| `storage` | 存划线、设置与未定位清单（同时覆盖 `storage.sync`） |
| `contextMenus` | 右键菜单（图标上的入口、页面上的「复制标题和链接」） |
| `clipboardWrite` | 右键菜单触发的复制（没有页面手势，`execCommand` 需要它） |
| `scripting` + `activeTab` | 扩展更新后旧标签页里的复制（`executeScript` 在当次点击内注入，用完即止） |
| `host_permissions: api.deepseek.com` | 翻译 / 解释的请求 |

翻译 / 解释需要一个 DeepSeek API Key：加密后随偏好设置同步到别的设备（同步区里也只有密文），
但不写进备份文件。不开同步、也不用翻译 / 解释时，扩展不会产生任何对外请求。

## 开发

需要 Node >= 26.12 与 pnpm（版本见 `package.json`）。

| 命令 | 作用 |
| --- | --- |
| `pnpm build` | 生产构建 → `dist/chrome/` |
| `pnpm watch` | 监视 `src/` 自动重建 |
| `pnpm test` | 单元测试（`node:test`） |
| `pnpm typecheck` | 类型检查（需先 build） |
| `pnpm verify` | 产物自检 |

工程约定见 `AGENTS.md`，功能与架构说明见 `docs/design.md`。具体的交互与逻辑以代码为准。

## 许可

MIT
