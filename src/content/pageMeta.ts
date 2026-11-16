/**
 * 页面元信息：右键菜单「复制标题和链接」要用的两个原始值。
 *
 * 只负责**读**：候选的顺序与取舍规则在 `shared/copyLink.ts` 里（纯函数、可测）。
 * 别在这里加站点特判——每加一个站点的选择器就要跟着维护一次，而 `document.title`
 * 与 canonical 覆盖了绝大多数页面。
 */
import {
  formatCopyLink,
  linkFrom,
  preferSelection,
  titleFrom,
  type CopyLinkStyle,
  type PageCandidates
} from '../shared/copyLink'

/**
 * 读候选。**函数体必须自包含**：它同时作为 `chrome.scripting.executeScript` 的 `func`
 * 被序列化注入到页面（扩展更新后旧标签页的 content script 已脱钩，只能这样救），
 * 那里引用不到模块作用域的任何东西。
 *
 * 在 content script 里它也只是普通调用——页面上下文本来就有 `document`。
 */
export function readPageCandidatesInPage(): PageCandidates {
  const attr = (selector: string, name: string): string =>
    document.querySelector(selector)?.getAttribute(name) ?? ''
  return {
    title: document.title || '',
    ogTitle: attr('meta[property="og:title"]', 'content'),
    heading: document.querySelector('h1')?.textContent ?? '',
    href: window.location.href,
    host: window.location.hostname,
    canonical: attr('link[rel="canonical"]', 'href'),
    ogUrl: attr('meta[property="og:url"]', 'content')
  }
}

/**
 * 一次性拼好、可直接写剪贴板的内容。
 *
 * `selected` 是右键那一刻的选中文字（可能已被 Chrome 截断的那一份，也可能来自页面
 * 实时选区——两者都是「用户选中的文字」，调用方优先给实时的那份）。非空时它顶替网页标题。
 */
export function copyLinkText(style: CopyLinkStyle, selected = ''): string {
  const candidates = readPageCandidatesInPage()
  return formatCopyLink(preferSelection(selected, titleFrom(candidates)), linkFrom(candidates), style)
}
