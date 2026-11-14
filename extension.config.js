/** @type {import('extension').FileConfig} */
// 只做 Chrome。只保留 build：`dev` / `start` / `preview` 需要下载独立的 Chrome for Testing，
// 且 `dev` 会产出带额外权限的开发版清单，本项目不做自动化验收，所以不留这些脚本。
const ciFlags = process.env.CI ? ['--no-sandbox', '--disable-gpu'] : []

export default {
  browser: {
    chrome: {browserFlags: ciFlags}
  },
  // 必须锁定 chrome：否则默认产出 dist/chromium，而 tools/verify-build.mjs 是按 dist/chrome 自检的。
  commands: {
    build: {browser: 'chrome'}
  }
}
