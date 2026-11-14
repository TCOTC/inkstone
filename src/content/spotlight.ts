/**
 * 跳转提示框。
 *
 * 从列表/标记点跳到某条划线后，画一个**亮黄色描边框**把目标圈一下，
 * 并在滚动过程中一直跟随，滚动停下后再停留一会儿淡出。
 *
 * 具体规则：
 * - 框 = 该划线**所有**落点矩形的并集，向外各扩 4px、宽高各加 8px；
 * - `border: 3px solid <色>` + `background: <色> 10%` + `border-radius: 8px`；
 * - `position: fixed`（视口坐标），`pointer-events: none`；
 * - `requestAnimationFrame` 循环重算位置，**连续 15 帧位移小于 1px** 就认为滚动停了；
 * - 停下后停留 **1000ms**，然后 `opacity: 0`（0.3s 过渡），再过 **300ms** 移除。
 *
 * 循环在框可见期间**一直跑**，所以在停留的那 1 秒里再滚一次也跟得上：
 * 位移一出现就把停留计时清零、重新按「停稳 1 秒」算起，而不是让框僵在原地。
 *
 * 两处刻意的选择：
 * 1. **颜色**：用划线 hover 时的亮黄（`HOVER_COLOR`）而不是红。
 *    亮黄在黄底划线周围会糊成一片，所以额外加了一圈 1px 的深色外环与黄色微光，
 *    保证在白色页面与黄色高亮上都能看出来。
 * 2. 不每帧新建 div 再替换，而是复用同一个节点只更新 `style`，
 *    省掉每帧的 DOM 创建/销毁，观感一致。
 */
import {HOVER_COLOR, stripAlpha} from '../shared/colors'
import {unionBoxes, type Box} from './geometry'

const BOX_COLOR = stripAlpha(HOVER_COLOR)

export interface SpotlightSource {
  /** 该划线的全部落点矩形（视口坐标）。拿不到时返回空数组。 */
  rectsOf: (id: number) => readonly Box[]
}

/** 连续这么多帧位移 < 1px 就认为滚动停下。 */
const STABLE_FRAMES = 15
/** 停稳后的停留时间。 */
const HOLD_MS = 1000
/** 淡出过渡时长（与 CSS 里的 `transition` 一致）。 */
const FADE_MS = 300
const STYLE_ID = 'inkstone-spotlight'

const STYLE = `
:host { all: initial; }
/* 不写 box-sizing：保留默认的 content-box，边框会额外占 3px，不要改。 */
.box {
  position: fixed;
  z-index: 2147482999;
  border: 3px solid ${BOX_COLOR};
  background-color: ${BOX_COLOR}1f;
  /* 亮黄在白底与黄底高亮上都偏淡，靠深色外环 + 黄色微光把它拉出来。 */
  box-shadow: 0 0 0 1px rgba(0, 0, 0, .3), 0 0 14px ${BOX_COLOR}b3;
  border-radius: 8px;
  pointer-events: none;
  transition: opacity .3s ease-out;
  opacity: 1;
  display: block;
}
.box.hidden { display: none; }
`

export class Spotlight {
  private readonly host: HTMLElement
  private readonly root: ShadowRoot
  private readonly box: HTMLElement
  private source: SpotlightSource | null = null
  private frame = 0
  private holdTimer = 0
  private removeTimer = 0

  constructor() {
    this.host = document.createElement('inkstone-spotlight')
    this.root = this.host.attachShadow({mode: 'open'})

    const style = document.createElement('style')
    style.textContent = STYLE
    style.id = STYLE_ID

    this.box = document.createElement('div')
    this.box.className = 'box hidden'

    this.root.append(style, this.box)
    ;(document.documentElement ?? document.body).appendChild(this.host)
  }

  bind(source: SpotlightSource): void {
    this.source = source
  }

  /**
   * 圈出某条划线。滚动还没停时会一直跟随（每帧重算，所以平滑滚动也跟得上）。
   *
   * 重复调用会先清掉上一次的框与计时器。
   */
  show(id: number): void {
    this.stop()
    const rects = this.source?.rectsOf(id) ?? []
    const union = unionBoxes(rects)
    if (!union) return

    this.box.classList.remove('hidden')
    this.box.style.opacity = '1'
    this.paint(union)

    let lastTop = union.y - 4
    let stable = 0

    const tick = (): void => {
      this.frame = 0
      const next = this.source?.rectsOf(id) ?? []
      // 元素暂时消失（重渲染）时保留上一次的位置，不闪掉框。
      const box = unionBoxes(next)
      if (box) this.paint(box)

      const top = Number.parseFloat(this.box.style.top)
      if (Number.isFinite(top) && Math.abs(top - lastTop) < 1) {
        stable += 1
      } else {
        // 又动了（用户手动滚 / 上一段平滑滚动还没停）：停留计时作废，出框重新等。
        stable = 0
        this.cancelHold()
      }
      lastTop = top

      // 停稳之后才起表；边界过了也一直跟，直到真开始淡出。
      if (stable >= STABLE_FRAMES && !this.holdTimer) {
        this.holdTimer = window.setTimeout(() => this.fade(), HOLD_MS)
      }
      this.frame = requestAnimationFrame(tick)
    }

    this.frame = requestAnimationFrame(tick)
  }

  /** 开始淡出：先停掉跟随循环，再等过渡结束把框藏起来。 */
  private fade(): void {
    this.holdTimer = 0
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
    this.box.style.opacity = '0'
    this.removeTimer = window.setTimeout(() => {
      this.removeTimer = 0
      this.box.classList.add('hidden')
    }, FADE_MS)
  }

  /** 有位移就撤掉停留计时（还没起表时什么都不做）。 */
  private cancelHold(): void {
    if (!this.holdTimer) return
    window.clearTimeout(this.holdTimer)
    this.holdTimer = 0
  }

  /** 立刻撤掉（换页、关扩展、用户又点别的地方时）。 */
  stop(): void {
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
    if (this.holdTimer) window.clearTimeout(this.holdTimer)
    this.holdTimer = 0
    if (this.removeTimer) window.clearTimeout(this.removeTimer)
    this.removeTimer = 0
    this.box.classList.add('hidden')
    this.box.style.opacity = '1'
  }

  /** 把并集矩形写进行内样式：四周各外扩 4px（宽高因此各加 8）。 */
  private paint(box: Box): void {
    this.box.style.top = `${box.y - 4}px`
    this.box.style.left = `${box.x - 4}px`
    this.box.style.width = `${box.width + 8}px`
    this.box.style.height = `${box.height + 8}px`
  }
}
