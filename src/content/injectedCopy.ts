/**
 * 扩展更新后，旧标签页里那条 content script 已脱钩（见 `content/extensionAlive.ts`）：
 * 页面还在，但 `chrome.*` 全失效，`tabs.sendMessage` 没有接收方。
 *
 * 这条路走得通是因为 `chrome.scripting.executeScript` 注入的脚本属于**当前这个**扩展实例，
 * 它的 `chrome` 是活的；而页面本身（`document`、焦点、剪贴板）也都在。
 * 于是右键菜单可以当场做完，不必让用户重载页面。
 *
 * 两个函数都必须**完全自包含**：Chrome 会把 `func` 序列化后注入，模块作用域的引用
 * （包括常量与 import）在页面里根本不存在。别为了「复用」把它们抽成小工具函数。
 */

/**
 * 写剪贴板，并在页面底部闪一句提示。
 *
 * 与 `content/clipboard.ts` 的差别：那边首选 `navigator.clipboard.writeText()`，
 * 这里**只用** textarea + `execCommand('copy')`——注入的是一次性脚本，而
 * `navigator.clipboard` 要求文档获得焦点，失败模式比 `execCommand` 多。
 *
 * 提示自己画（不用 `content/toast.ts`）：那边是旧脚本里的实例，跨不了脚本边界。
 */
export function writeClipboardInPage(text: string, okText: string, failText: string): boolean {
  let ok = false
  const area = document.createElement('textarea')
  try {
    area.value = text
    area.setAttribute('readonly', '')
    // 不能 display:none / visibility:hidden：那样选不中，copy 会拿到空串。
    area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;'
    ;(document.body ?? document.documentElement).appendChild(area)
    area.select()
    area.setSelectionRange(0, text.length)
    ok = document.execCommand('copy')
  } catch {
    ok = false
  } finally {
    area.remove()
  }

  const tip = document.createElement('div')
  tip.textContent = ok ? okText : failText
  // 行内样式 + 独立于站点样式的定位：这一层不跟页面主题走，深色页面上也能看清。
  tip.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:40px',
    'transform:translateX(-50%)',
    'max-width:min(420px,calc(100vw - 32px))',
    'padding:8px 14px',
    'border-radius:8px',
    'background:rgba(31,35,40,.92)',
    'color:#fff',
    'font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
    'white-space:nowrap',
    'overflow:hidden',
    'text-overflow:ellipsis',
    'z-index:2147483647',
    'pointer-events:none',
    'box-shadow:0 2px 8px rgba(0,0,0,.24)'
  ].join(';')
  ;(document.documentElement ?? document.body).appendChild(tip)
  window.setTimeout(() => tip.remove(), 1600)
  return ok
}
