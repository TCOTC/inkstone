/**
 * 管理页的入口：按 hash 决定挂载哪个 Vue 视图。
 *
 * - `options/index.html`（或 `#settings/<group>`）→ 偏好设置
 * - `options/index.html#library` → 我的划线
 *
 * 两个视图共用同一个 HTML 入口：构建工具只为清单里声明的页面角色打包 HTML
 * （`options_page` → `options/`、`action.default_popup` → `action/`），
 * 自造的第三个 `.html` 不会进产物。共用入口的代价只有几 KB 的 JS/CSS，换来路径稳定。
 *
 * 不引 vue-router：只有两个视图，hash 分发一个三元就够。
 * 设置内部的分组（`#settings/ai`）由 `App.vue` 自己用 `replaceState` 切，
 * **不走 hashchange**——那会把整个实例卸载重建，输入框会丢焦点。
 */
import {createApp, type App as VueApp} from 'vue'
import AppView from '../app/App.vue'
import LibraryView from '../app/Library.vue'
import {LIBRARY_HASH} from '../shared/route'
import '../app/theme.css'
import './app.css'
import './library.css'

/** 上一个挂载的实例：hash 变化时先卸载，否则会叠加两份 DOM 与事件。 */
let current: VueApp | null = null

/** 按 hash 挂载视图。hash 变化时不重新加载页面，所以这里要被 hashchange 反复调用。 */
function render(): void {
  // 用前缀判断：选中某页时 hash 会变成 `#library/<URL>`，仍然是这个视图。
  const view: 'library' | 'settings' = location.hash.startsWith(LIBRARY_HASH) ? 'library' : 'settings'

  document.body.className = `view-${view}`
  document.title = view === 'library' ? '我的划线 · Inkstone' : '偏好设置 · Inkstone'

  const root = document.getElementById('root')
  if (!root) return

  current?.unmount()
  current = null

  // `library.css` 的规则全部挂在 `.library` 下，class 留在 #root 上（布局容器是 #root 本身）。
  root.classList.toggle('library', view === 'library')

  current = createApp(view === 'library' ? LibraryView : AppView)
  current.mount(root)
}

render()
// 从偏好设置点「我的划线」（或反过来）只改 hash，不会重新加载文档。
window.addEventListener('hashchange', render)
