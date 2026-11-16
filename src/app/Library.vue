<!--
  「我的划线」：左列所有页面，右列该页的划线；左列顶部还有「未定位」入口。

  与「偏好设置」共用 `options/index.html`，只靠 hash 区分视图（分发在 `pages/app.ts`）。
  「打开网页」一律走 `openTabAfterCurrent` + `#inkstone-hl=<id>`，不做 iframe 内嵌：
  目标站点普遍带 `X-Frame-Options` / `frame-ancestors`，内嵌必然白屏。

  未定位清单放在这里而不是设置页：它是数据视图，不是一项设置。
  清单里**只显示原文与所在页**：错误码对使用者没有意义，挂在行的 `title` 上供排障。
-->
<script setup lang="ts">
import {computed, nextTick, onMounted, ref, shallowRef, watch} from 'vue'
import {listPages} from '../shared/db'
import {formatDate} from '../shared/date'
import {filterPages, sortPages} from '../shared/library'
import {readSelectedPage, selectedPageHash, settingsGroupHash, withHighlightAnchor} from '../shared/route'
import {type HighlightRecord, type PageRecord} from '../shared/types'
import {clearUnresolved, listUnresolved, type UnresolvedPage} from '../shared/unresolved'
import {hostOf} from '../shared/url'
import {openTabAfterCurrent} from './openTab'

const pages = shallowRef<PageRecord[]>([])
const query = ref('')
const selected = ref<string | null>(readSelectedPage(location.hash))
const listRef = ref<HTMLElement | null>(null)
const detailRef = ref<HTMLElement | null>(null)

/** 右列当前显示未定位清单，而不是某一页的划线。 */
const showUnresolved = ref(false)
const unresolved = shallowRef<UnresolvedPage[]>([])

const unresolvedTotal = computed(() =>
  unresolved.value.reduce((sum, entry) => sum + entry.items.length, 0)
)

const highlightTotal = computed(() =>
  pages.value.reduce((sum, page) => sum + page.highlights.length, 0)
)

const visible = computed(() => filterPages(pages.value, query.value))

/**
 * 详情永远在**全部页面**里找，不在过滤结果里找：搜索时右侧仍显示当前页，
 * 直到过滤结果不再包含它（那时自动跳到第一项）。
 */
const currentPage = computed(
  () => pages.value.find((page) => page.url === selected.value) ?? null
)

/**
 * 右侧划线的展示行。
 *
 * 日期在这里算一次：模板里「有日期才显示 + 显示日期」写两个 `formatDate` 会让每行
 * 付两次格式化成本（`Intl` 调用即使复用实例也不是免费的），而且两次结果必然相同。
 */
const detailRows = computed(() =>
  (currentPage.value?.highlights ?? []).map((highlight) => ({
    highlight,
    date: formatDate(highlight.createdAtSec)
  }))
)

/** 列表行的一行元信息：站点 · 日期 · 条数。 */
function rowMeta(page: PageRecord): string {
  return [hostOf(page.url), formatDate(page.createdAtSec), `${page.highlights.length} 条`]
    .filter(Boolean)
    .join(' · ')
}

/** 详情页的元信息：站点 · 创建日期 · 条数。一行说完，不再另置计数。 */
function detailMeta(page: PageRecord): string {
  return [hostOf(page.url), formatDate(page.createdAtSec), `${page.highlights.length} 条划线`]
    .filter(Boolean)
    .join(' · ')
}

function selectPage(url: string | null): void {
  showUnresolved.value = false
  if (url === selected.value) return
  selected.value = url
  if (url !== null) history.replaceState(null, '', selectedPageHash(url))
}

function openUnresolved(): void {
  showUnresolved.value = true
}

/** 过滤结果变了以后，保证选中项仍然可见；否则落回第一项。 */
function ensureSelection(): void {
  const list = visible.value
  if (list.length === 0) {
    selectPage(null)
    return
  }
  if (selected.value !== null && list.some((page) => page.url === selected.value)) return
  selectPage(list[0]?.url ?? null)
}

function openSettings(): void {
    location.hash = settingsGroupHash('highlight')
}

async function onClearUnresolved(): Promise<void> {
  if (!window.confirm('清空未定位清单？划线本身仍在，只是不再列出来。')) return
  await clearUnresolved()
  unresolved.value = []
  showUnresolved.value = false
}

function openPage(url: string): void {
  void openTabAfterCurrent(url)
}

function jump(page: PageRecord, highlight: HighlightRecord): void {
  void openTabAfterCurrent(withHighlightAnchor(page.url, highlight.id))
}

watch(visible, ensureSelection)

/** 换页 / 换视图后右列回到顶部：否则会停在上一页的滚动位置。 */
watch([selected, showUnresolved], async () => {
  await nextTick()
  if (detailRef.value) detailRef.value.scrollTop = 0
  listRef.value?.querySelector('.row.active')?.scrollIntoView({block: 'nearest'})
})

onMounted(async () => {
  pages.value = sortPages(await listPages())
  unresolved.value = await listUnresolved()
  ensureSelection()
})
</script>

<template>
  <!--
    **没有页头**：标题、计数与「偏好设置」入口都在侧栏里。
    页头会白占一条横向空间，而这两栏本来就各有一块常驻的空白可用。
  -->
  <main class="layout">
    <aside class="side">
      <div class="side-head">
        <h1>我的划线</h1>
        <span v-if="pages.length > 0" class="side-count">{{ pages.length }} 页 · {{ highlightTotal }} 条</span>
      </div>

      <div v-if="pages.length > 0" class="search-wrap">
        <svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          v-model="query"
          class="search"
          type="search"
          aria-label="搜索页面"
          placeholder="搜索标题、站点或原文"
        />
      </div>

      <div ref="listRef" class="list">
        <p v-if="pages.length === 0" class="empty">还没有划线</p>
        <template v-else>
          <!-- 未定位不是一页，但又必须能点进来，所以放在列表第一项。 -->
          <button
            v-if="unresolvedTotal > 0"
            type="button"
            class="row alert"
            :class="{active: showUnresolved}"
            @click="openUnresolved"
          >
            <span class="row-title">未定位</span>
            <span class="row-meta">{{ unresolvedTotal }} 条</span>
          </button>

          <button
            v-for="page in visible"
            :key="page.url"
            type="button"
            class="row"
            :class="{active: !showUnresolved && page.url === selected}"
            @click="selectPage(page.url)"
          >
            <span class="row-title">{{ page.title || page.url }}</span>
            <span class="row-meta">{{ rowMeta(page) }}</span>
          </button>

          <p v-if="visible.length === 0" class="empty">没有匹配的页面。</p>
        </template>
      </div>

      <footer class="side-foot">
        <a class="link icon-link" href="#" @click.prevent="openSettings">
          偏好设置
          <svg class="arrow" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14" />
            <path d="m12 5 7 7-7 7" />
          </svg>
        </a>
      </footer>
    </aside>

    <section ref="detailRef" class="detail">
      <article class="detail-inner">
        <template v-if="pages.length === 0">
          <div class="detail-empty">
            <p class="empty">本地还没有数据。</p>
            <button class="primary" @click="openSettings">导入备份</button>
          </div>
        </template>

        <template v-else-if="showUnresolved">
          <header class="detail-head">
            <h2>未定位</h2>
            <p class="detail-meta">{{ unresolvedTotal }} 条 · 正文里找不到原文</p>
            <div class="actions">
              <button class="ghost small" @click="onClearUnresolved">清空清单</button>
            </div>
          </header>

          <div class="unresolved">
            <section v-for="entry in unresolved" :key="entry.url" class="unresolved-page">
              <header class="unresolved-head">
                <span class="unresolved-title">{{ entry.title || entry.url }}</span>
                <button class="ghost small" @click="openPage(entry.url)">打开页面</button>
              </header>
              <!-- 只列原文。错误码进 `title`，需要排障时鼠标停上去就有。 -->
              <p
                v-for="item in entry.items"
                :key="item.id"
                class="unresolved-line"
                :title="`错误码 ${item.errCode}`"
              >{{ item.preview }}</p>
            </section>
          </div>
        </template>

        <template v-else-if="currentPage">
          <header class="detail-head">
            <h2>{{ currentPage.title || currentPage.url }}</h2>
            <p class="detail-meta">{{ detailMeta(currentPage) }}</p>
            <div class="actions">
              <button class="primary small" @click="openPage(currentPage.url)">打开网页</button>
            </div>
          </header>

          <p v-if="currentPage.highlights.length === 0" class="empty">这一页没有划线。</p>
          <ol v-else class="highlights">
            <li v-for="row in detailRows" :key="row.highlight.id" class="hl">
              <blockquote class="hl-text">{{ (row.highlight.text || '（无文字）').trim() }}</blockquote>
              <div class="hl-foot">
                <span class="hl-date">{{ row.date }}</span>
                <button
                  type="button"
                  class="ghost small"
                  @click="jump(currentPage, row.highlight)"
                >在网页中定位</button>
              </div>
            </li>
          </ol>
        </template>

        <p v-else class="empty">选择左侧的页面。</p>
      </article>
    </section>
  </main>
</template>
