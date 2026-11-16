/**
 * 页面底部中央的一次性提示。
 *
 * 只给「没有浮层承载反馈」的动作用——右键菜单复制成功 / 失败。划词工具条有自己的
 * `notice`（跟着选区摆），不要往这里塞。
 *
 * 配色跟工具条同一套机制（`color-scheme: inherit` + `light-dark()`）：
 * 浅色页面给深色胶囊 + 白字，深色页面反过来，两向都够对比度。
 */

const STYLE = `
:host { all: initial; color-scheme: inherit; }
.toast {
  position: fixed;
  left: 50%;
  bottom: 40px;
  transform: translateX(-50%);
  max-width: min(420px, calc(100vw - 32px));
  padding: 8px 14px;
  border-radius: 8px;
  background: light-dark(rgba(31, 35, 40, .92), rgba(230, 232, 235, .95));
  color: light-dark(#fff, #1f2328);
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  z-index: 2147483001;
  pointer-events: none;
  opacity: 0;
  transition: opacity .15s ease-out;
}
.toast.on { opacity: 1; }
`

/** 停留时长：够读一句短话，又不至于挡住页面。 */
const VISIBLE_MS = 1600

export class Toast {
  private readonly host: HTMLElement
  private readonly root: ShadowRoot
  private readonly box: HTMLElement
  private timer = 0

  constructor() {
    this.host = document.createElement('inkstone-toast')
    this.root = this.host.attachShadow({mode: 'open'})

    const style = document.createElement('style')
    style.textContent = STYLE

    this.box = document.createElement('div')
    this.box.className = 'toast'
    // 只用于读屏；视觉上不占位。
    this.box.setAttribute('role', 'status')

    this.root.append(style, this.box)
    ;(document.documentElement ?? document.body).appendChild(this.host)
  }

  /** 连续调用只刷新文字并重新计时，不排队。 */
  show(text: string): void {
    this.box.textContent = text
    this.box.classList.add('on')
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => this.hide(), VISIBLE_MS)
  }

  hide(): void {
    this.box.classList.remove('on')
    window.clearTimeout(this.timer)
    this.timer = 0
  }
}
