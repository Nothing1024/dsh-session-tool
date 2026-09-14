import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'

const launchUrl = process.env.DSH_E2E_URL
if (!launchUrl) throw new Error('Set DSH_E2E_URL to the local DSH authenticated launch URL')
const target = new URL(launchUrl)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('Browser verification requires a local DSH test profile')
const executablePath = process.env.CHROME_BIN ?? (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome')
if (!existsSync(executablePath)) throw new Error('Set CHROME_BIN to an installed Chrome executable')
const browser = await chromium.launch({ executablePath, headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', error => errors.push(error.message))
const name = `侧栏验收-${randomUUID().slice(0, 8)}`
let sessionId: string | undefined

async function rpc(method: string, payload: unknown): Promise<unknown> {
  const response = await context.request.post(`${target.origin}/api/${method}`, {
    data: { type: 'client-request', rpcId: randomUUID(), method, payload },
  })
  assert.equal(response.status(), 200)
  const envelope = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
  assert.equal(envelope.result.ok, true, envelope.result.error?.message)
  return envelope.result.value
}

try {
  const authentication = await context.request.get(launchUrl, { maxRedirects: 0 }).catch(() => { throw new Error('DSH authentication failed') })
  assert.equal(authentication.status(), 303)
  await page.goto(target.origin)
  await page.getByRole('button', { name: '会话协作', exact: true }).waitFor()
  const notice = page.getByRole('dialog').filter({ hasText: '内测声明' })
  const showNotice = await notice.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)
  if (showNotice) await notice.getByRole('button', { name: '继续', exact: true }).click()
  const modelSetup = page.getByRole('dialog').filter({ hasText: '添加一个 API Key 开始使用' })
  const showSetup = await modelSetup.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)
  if (showSetup) await modelSetup.getByRole('button', { name: '稍后配置', exact: true }).click()
  const created = await rpc('session/create', { args: { request: { cwd: resolve('.') } } }) as { sessionId: string }
  sessionId = created.sessionId
  await rpc('session-tool/rename', { sessionId, title: name })
  await page.getByRole('button', { name: '会话协作', exact: true }).click()
  await page.getByRole('heading', { name: '会话协作', exact: true }).waitFor()
  await page.getByRole('textbox', { name: '搜索会话标题', exact: true }).fill(name)
  await page.locator('.st-row').filter({ hasText: name }).click()
  await page.getByRole('heading', { name, exact: true }).waitFor()
  await page.getByText('会话还没有消息。', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '停止当前轮次', exact: true }).isDisabled(), true)
  const renamed = `${name}-已核验`
  await page.getByRole('textbox', { name: '会话标题', exact: true }).fill(renamed)
  await page.getByRole('button', { name: '保存标题', exact: true }).click()
  await page.getByRole('heading', { name: renamed, exact: true }).waitFor()
  await page.getByRole('button', { name: '插件内隐藏', exact: true }).click()
  await page.getByRole('button', { name: '取消插件隐藏', exact: true }).waitFor()
  await page.getByRole('checkbox', { name: '包含隐藏', exact: true }).check()
  await page.locator('.st-row').filter({ hasText: renamed }).waitFor()
  const hidden = await rpc('session-tool/read', { sessionId }) as { visibility: { hasHiddenMark: boolean; archived: boolean } }
  assert.equal(hidden.visibility.hasHiddenMark, true)
  assert.equal(hidden.visibility.archived, false)
  await page.getByRole('button', { name: '取消插件隐藏', exact: true }).click()
  await page.getByRole('button', { name: '插件内隐藏', exact: true }).waitFor()
  const screenshot = process.env.DSH_E2E_SCREENSHOT
  if (screenshot) { mkdirSync(resolve(screenshot, '..'), { recursive: true }); await page.screenshot({ path: screenshot, fullPage: true }) }
  await page.getByRole('button', { name: '在对话中打开', exact: true }).click()
  await page.locator('.st-panel').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '会话协作', exact: true }).click()
  await page.getByRole('heading', { name: '会话协作', exact: true }).waitFor()
  await page.setViewportSize({ width: 640, height: 900 })
  assert.equal(await page.locator('.st-panel').evaluate(element => element.scrollWidth <= element.clientWidth), true)
  assert.deepEqual(errors, [])
  console.log('PASS: official sidebar, real session list/read/rename/hide/unhide, native navigation, narrow viewport; no page errors')
} finally {
  try {
    if (sessionId) await rpc('workspace/archiveSession', { args: { request: { sessionId } } })
  } finally { await browser.close() }
}
