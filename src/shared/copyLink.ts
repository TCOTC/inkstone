/**
 * 「复制标题和链接」的取值与拼装规则。
 *
 * 全是纯函数：DOM 里能拿到什么（`document.title`、canonical、og:url）由
 * `content/pageMeta.ts` 负责，这里只决定用哪个候选、剪多长、怎么拼。
 */

/** 文本 = 标题一行 + 链接一行；Markdown = `[标题](链接)`。 */
export type CopyLinkStyle = 'text' | 'md'

/**
 * 页面里能读到的原始候选。
 *
 * 之所以先取原始值、再把取舍交给纯函数：扩展更新后旧标签页的 content script 已脱钩，
 * 复制要改用 `chrome.scripting.executeScript` 注入的临时脚本（见 `background.ts`）。
 * 注入的函数只能自包含、不能 import，所以它只负责**读**，挑选与拼装仍走这里的纯函数。
 */
export interface PageCandidates {
  /** `document.title` */
  title: string
  /** `meta[property="og:title"]` 的 content */
  ogTitle: string
  /** 正文首个 `h1` 的文本 */
  heading: string
  /** `location.href` */
  href: string
  /** `location.hostname` */
  host: string
  /** `link[rel="canonical"]` 的 href */
  canonical: string
  /** `meta[property="og:url"]` 的 content */
  ogUrl: string
}

/** 空标题的占位：粘贴出去至少还能看出是哪一页，而不是孤零零一行链接。 */
const FALLBACK_TITLE = 'No Title'

/**
 * 社交站点的时间线会把整段正文塞进 `document.title`（还带换行），
 * 所以只留第一行、截 64 字符；其余站点 256 字符。
 */
const SOCIAL_HOSTS = new Set(['web.okjike.com', 'twitter.com', 'x.com'])
const SOCIAL_TITLE_MAX = 64
const TITLE_MAX = 256

function clamp(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

/**
 * 挑标题：候选按优先级给出（`document.title` → `og:title` → `h1`），取第一个非空。
 *
 * 全空给 `No Title`——复制一个空行粘贴出去，用户只会以为复制坏了。
 */
export function pickTitle(candidates: readonly string[], host: string): string {
  const found = candidates.map((value) => value.trim()).find((value) => value.length > 0)
  if (found === undefined) return FALLBACK_TITLE
  if (!SOCIAL_HOSTS.has(host)) return clamp(found, TITLE_MAX)
  const firstLine = found
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return clamp(firstLine ?? found, SOCIAL_TITLE_MAX)
}

/**
 * 挑链接：优先站点声明的 canonical（去掉会话参数的那一份），其次 og:url。
 *
 * 相对地址按地址栏补全；解析失败或不是 http(s) 就退回地址栏——
 * `javascript:` 这类值不能写进剪贴板。
 */
export function pickLink(href: string, candidates: readonly string[]): string {
  for (const candidate of candidates) {
    const raw = candidate.trim()
    if (raw === '') continue
    try {
      const url = new URL(raw, href)
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
    } catch {
      // 脏值：继续看下一个候选。
    }
  }
  return href
}

/**
 * 标题从哪来：**有选中文字就用选中的文字**（右键落在选区上时用户要的是那段文字），
 * 空串或纯空白才退回网页标题。
 *
 * 选区**不截断**：那是用户自己圈出来的东西，砍掉一半比不复制更糟。
 */
export function preferSelection(selected: string, fallback: string): string {
  const text = selected.trim()
  return text === '' ? fallback : text
}

/** 候选 → 标题。顺序只有这一处。 */
export function titleFrom(candidates: PageCandidates): string {
  return pickTitle([candidates.title, candidates.ogTitle, candidates.heading], candidates.host)
}

/** 候选 → 链接。顺序只有这一处。 */
export function linkFrom(candidates: PageCandidates): string {
  return pickLink(candidates.href, [candidates.canonical, candidates.ogUrl])
}

/**
 * 字符类扫描适合短文本，长文本使用 V8 更高效的字面量扫描路径。
 * 两段输出**逐字符相同**，`copyLink.test.ts` 在边界两侧各验一次。
 */
const SINGLE_PASS_ESCAPE_MAX_LENGTH = 512

/**
 * 把纯文本里的 Markdown 标记全部转义。
 *
 * **宁可吵也不漏**：`( ) = # . $ ^ |` 这些在标题里到处都是（版本号、问句、括号），
 * 转义后在 Markdown 里渲染结果完全一样，只是源码多几个反斜杠；不转义则 `*` `_`
 * 反引号 `[` 这些会静默改掉排版。这是「链接文字」语法要求的超集，代价是源码可读性。
 */
export function escapeMarkdownPlainText(text: string): string {
  if (text.length > SINGLE_PASS_ESCAPE_MAX_LENGTH) {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/\*/g, '\\*')
      .replace(/_/g, '\\_')
      .replace(/\[/g, '\\[')
      .replace(/]/g, '\\]')
      .replace(/!/g, '\\!')
      .replace(/`/g, '\\`')
      .replace(/</g, '\\<')
      .replace(/>/g, '\\>')
      .replace(/&/g, '\\&')
      .replace(/~/g, '\\~')
      .replace(/{/g, '\\{')
      .replace(/}/g, '\\}')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/=/g, '\\=')
      .replace(/#/g, '\\#')
      .replace(/\$/g, '\\$')
      .replace(/\^/g, '\\^')
      .replace(/\|/g, '\\|')
      .replace(/\./g, '\\.')
  }
  return text.replace(/[\\*_[\]!`<>&~{}()=#$^|.]/g, '\\$&')
}

/**
 * Markdown 链接文字必须是单行：选中多段文字时先把所有连续空白折成一个空格。
 * 折完再转义（转义只会插入反斜杠，不会再产生空白）。
 */
function mdLabel(text: string): string {
  return escapeMarkdownPlainText(text.replace(/\s+/g, ' ').trim())
}

/**
 * 拼最终文本。
 *
 * 文本模式两行，**不加末尾换行**（粘贴到输入框里不会多出空行）；多行选区原样保留，
 * 只有链接单独占最后一行。
 */
export function formatCopyLink(title: string, link: string, style: CopyLinkStyle): string {
  if (style === 'md') return `[${mdLabel(title)}](${link})`
  return `${title.trim()}\n${link}`
}
