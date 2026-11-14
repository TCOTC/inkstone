/**
 * 扩展生命周期：判断本页的 content script 是否已经和扩展脱钩。
 *
 * 扩展被更新（含开发模式在 `chrome://extensions` 点 ↻）、被停用、被卸载时，
 * **已经注入到旧标签页的 content script 不会被重新注入，也不会被卸载**：
 * 它的 DOM 监听、`CSS.highlights`、Shadow 宿主全都还在，但 `chrome.*` 全部失效
 * （`chrome.runtime.id` 变 `undefined`，任何调用都抛 `Extension context invalidated`）。
 *
 * 没有 API 能「让旧页面换用新扩展」，旧脚本只能自己发现、自己降级（`index.ts` 的
 * `enterStale()`）：高亮与浮层都是纯 DOM + CSS，不需要 `chrome.*`，所以照旧留着；
 * 划不出新划线也删不掉旧的（那要写存储），工具条上的按钮就地换成「刷新本页」。
 *
 * **为什么不用长连接**（`runtime.connect` + `port.onDisconnect`）来感知：
 * 端口断开既可能是扩展没了，也可能是 service worker 空闲 30 秒后正常休眠——
 * Chrome 114 起「开端口」不再重置空闲计时器，所以这条路上要重连、要心跳，
 * 等于主动把 worker 一直叫醒。轮询一个纯本地属性更便宜，也不会吵醒 worker。
 */

/**
 * 本页这条 content script 还挂在活着的扩展上吗？
 *
 * 只用属性读取与 `getURL`（纯本地计算，不走 IPC），可以放心地每秒问一次。
 * `chrome.runtime.id` 是通行判据，但它在个别过渡状态下还会留着值，
 * 所以再补一个调用：上下文一失效，任何 `chrome.*` 调用都会抛 `Extension context invalidated`。
 */
export function isExtensionAlive(): boolean {
  try {
    if (!chrome.runtime?.id) return false
    chrome.runtime.getURL('')
    return true
  } catch {
    return false
  }
}
