/**
 * 工具栏图标角标上的文字。
 *
 * 页面上不再有常驻的计数按钮，角标是唯一显示「本页一共划了多少条」的地方，
 * 所以这个数**包含未定位的划线**：它们同样是用户划过的线，只是这次回放没找到原文
 * （见 `shared/unresolved.ts`），页面上没有颜色可看，但不该从这个总数里消失。
 *
 * 空串表示不显示角标。Chrome 的角标最多能排下 4 个字符，超过 999 就写成 `999+`。
 * 纯函数：`background.ts` 拿它写角标，用例拿它验边界。
 */
export function badgeText(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return ''
  const count = Math.floor(total)
  return count > 999 ? '999+' : String(count)
}
