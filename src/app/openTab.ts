/**
 * 在管理页里新开一个标签：紧跟本页**后面**、同一窗口。
 *
 * 直接 `tabs.create({url})` 会排到窗口末尾，从「我的划线」连开几页后要回头看很远，
 * 才能回到刚离开的那一栏。`tabs.getCurrent()` 只读 id / windowId / index，
 * 不需要 `tabs` 权限；取不到（非标签页上下文）就退回默认位置，别让「打开」失败。
 */
export async function openTabAfterCurrent(url: string): Promise<void> {
  try {
    const self = await chrome.tabs.getCurrent()
    if (self) {
      await chrome.tabs.create({url, windowId: self.windowId, index: self.index + 1})
      return
    }
  } catch {
    // 落到下面：按默认位置（窗口末尾）打开。
  }
  await chrome.tabs.create({url})
}
