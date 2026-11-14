/**
 * 复制纯文本到剪贴板。
 *
 * 首选 `navigator.clipboard.writeText()`：它要求**用户手势**，而且在页面失焦
 * （点了别的窗口、刚切完标签页）时会抛 `NotAllowedError`。所以失败时退回
 * 「临时 textarea + `execCommand('copy')`」——同样需要手势，但不看焦点状态。
 *
 * 两条都失败就返回 `false`，让调用方给出失败反馈；**不要静默**，用户点一下
 * 什么反应都没有时会以为按钮坏了。
 *
 * 临时 textarea 会进正文 DOM（`execCommand` 只认文档里的选中内容），
 * 插进去到删掉之间只有同步的几步，不参与正文索引。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 落到下面的兜底路径。
  }
  return legacyCopy(text)
}

/** 兜底：选中一个屏幕外的 textarea 再执行 `copy`。 */
function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  // 不能 display:none / visibility:hidden：那样选不中，copy 会拿到空串。
  area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;'
  const host = document.body ?? document.documentElement
  host.appendChild(area)
  try {
    area.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}
