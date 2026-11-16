/**
 * 备份：把整库导出成一个 JSON 文件，再原样导回。
 *
 * 文件里存的**就是 `chrome.storage.local` 里的短键行**（见 `shared/rowCodec.ts`），所以
 * 「导出 → 手改 → 导入」这条路不需要第三套格式，也不会出现「备份能存下、
 * 库里存不下」的字段。
 *
 * 为什么只支持自己这一种格式：别的工具的导出是仓库里 `tools/` 的输入，
 * 扩展只吃自己这一种格式。这样字段不必为兼容别人的历史数据留任何余地。
 */
import {decodeRows, encodePage, type PageRow} from './rowCodec'
import {importPages, listPages, type ImportSummary} from './db'
import {loadSettings, normalizeSettings, saveSettings} from './settings'
import {type PageRecord, type Settings} from './types'

/** 文件标识。用户选错文件时给准确提示，比「解析失败」有用。 */
export const BACKUP_FORMAT = 'inkstone-backup'

export interface BackupFile {
  format: string
  exportedAt: number
  settings: Settings
  pages: PageRow[]
}

/** 生成一份备份（不落盘，由调用方决定怎么给用户）。 */
export async function buildBackup(): Promise<BackupFile> {
  const pages = await listPages()
  return {
    format: BACKUP_FORMAT,
    exportedAt: Date.now(),
    settings: await loadSettings(),
    pages: pages.map(encodePage)
  }
}

export type BackupParse =
  | {ok: true; pages: PageRecord[]; settings: Settings | null}
  | {ok: false; error: string}

/**
 * 解析备份文件。
 *
 * 只认自己这一种格式：`format` 对不上直接拒绝，不做任何「猜旧字段」的读取——
 * 字段含义一旦改了，硬读会得到「看起来导入成功、其实一半数据是错的」。
 */
export function parseBackup(data: unknown): BackupParse {
  if (!data || typeof data !== 'object') return {ok: false, error: '文件内容不是 JSON 对象。'}

  const file = data as Partial<BackupFile>
  if (file.format !== BACKUP_FORMAT) {
    return {ok: false, error: '这不是 Inkstone 的备份文件。'}
  }
  if (!Array.isArray(file.pages)) return {ok: false, error: '备份里没有 pages 数组。'}

  const pages = decodeRows(file.pages)
  if (pages.length === 0) return {ok: false, error: '备份里没有可导入的页面记录。'}

  return {ok: true, pages, settings: readSettings(file.settings)}
}

/** 备份里的设置：缺失时返回 null，否则按与存储同一套规则收成合法值。 */
function readSettings(value: unknown): Settings | null {
  if (!value || typeof value !== 'object') return null
  return normalizeSettings(value)
}

/** 把解析好的备份写进库（含设置）。 */
export async function applyBackup(parsed: {pages: PageRecord[]; settings: Settings | null}): Promise<ImportSummary> {
  const summary = await importPages(parsed.pages)
  if (parsed.settings) await saveSettings(parsed.settings)
  return summary
}

/** 备份文件名：`inkstone-backup-YYYYMMDD.json`。 */
export function backupFileName(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `inkstone-backup-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}.json`
}
