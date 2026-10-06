import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('package.json：DSH 插件清单完整', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-rss')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0)
  assert.equal(pkg.dsh.manifestVersion, 1)
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-tools'])
  assert.equal(pkg.peerDependenciesMeta['dsh-better-sidebar'].optional, true)
  assert.equal(pkg.scripts.test, 'node --test')
  assert.equal(pkg.scripts.check, 'node scripts/check.js')
  for (const f of pkg.files) {
    if (!f.endsWith('/')) assert.ok(existsSync(join(root, f)), `files 声明的 ${f} 应存在`)
  }
})

test('cordis.patch.yml：挂载行', () => {
  const y = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(y, /- insert:/)
  assert.match(y, /id:\s*dsh-rss\b/)
  assert.match(y, /name:\s*'dsh-rss'/)
})

test('client.js：模块级 inject 与可选 betterSidebar 嵌套注册（静态门禁）', () => {
  const c = readFileSync(join(root, 'client.js'), 'utf8')
  // 模块级依赖只声明 slots：betterSidebar 进模块级会让未装 better-sidebar 的宿主整模块不激活
  assert.match(c, /exports\.inject = \['slots'\]/, "client.js 应声明 exports.inject = ['slots']")
  assert.doesNotMatch(c, /exports\.inject = \[[^\]]*'betterSidebar'/, 'betterSidebar 不得进入模块级 inject')
  // 可选注册必须走嵌套 ctx.inject + scope.effect 持有 registerTab disposer
  assert.match(c, /ctx\.inject\(\['betterSidebar'\]/, 'betterSidebar 应经嵌套 ctx.inject 响应式注册')
  assert.match(c, /scope\.effect\(\s*function \(\) \{\s*return bs\.registerTab\(/, 'registerTab 注销函数应由 scope.effect 持有')
  // 禁止旧的「root 一次性查找 betterSidebar」形态（能力探测只允许出现在嵌套 scope 内）
  assert.doesNotMatch(c, /ctx\.get\('betterSidebar'\)/, '不得在 root ctx 一次性查找 betterSidebar')
})

test('client.js：左侧主导航两座位同身份（main + sidebar.panellist，静态门禁）', () => {
  const c = readFileSync(join(root, 'client.js'), 'utf8')
  // 契约同构 dsh-slidestudio registerStandalone / dsh-context watchInsightPage：
  // 两次注册、同一面板身份（main 的 key 与 panellist 的 id）
  assert.match(c, /var PANEL_ID = 'dsh-rss'/, '面板身份常量应为 dsh-rss')
  assert.match(c, /slots\.inject\('main', function \(\) \{/, '应注册 main 座位（布局根键控中栏页）')
  assert.match(c, /slots\.inject\('sidebar\.panellist', function \(\) \{/, '应注册 sidebar.panellist 座位（左栏行）')
  assert.match(c, /key: PANEL_ID/, 'main 页应以面板 key 关联')
  assert.match(c, /id: PANEL_ID, order: \d+, label: function \(\) \{ return 'RSS 阅读' \}/, '左栏行应含 id/order/label')
  assert.match(c, /--dsh-frame-top-clearance/, '主面板应为桌面窗口铬条留出官方间隙')
  assert.match(c, /typeof ctx\.effect === 'function'/, '导航停止函数应由 ctx.effect 持有（有守卫）')
})

test('关键文件在位', () => {
  for (const f of ['index.js', 'client.js', 'README.md', 'LICENSE', 'scripts/check.js', 'plugin-market.json', ...readdirSync(join(root, 'lib')).map((x) => `lib/${x}`)]) {
    assert.ok(existsSync(join(root, f)), `${f} 缺失`)
  }
})

test('README：中文文档覆盖安装/FreshRSS/AI/安全', () => {
  const r = readFileSync(join(root, 'README.md'), 'utf8')
  // 安装：desktop 走 GUI（添加插件 + Git 仓库地址），CLI 拒绝需说明；CLI 示例仅限自建 profile
  assert.ok(r.includes('添加插件') && r.includes('github.com/weixshaw/dsh-rss'), 'GUI 安装：添加插件 + Git 仓库地址')
  assert.ok(r.includes('managed exclusively by the Electron application'), 'desktop profile 的 CLI 拒绝说明')
  assert.ok(r.includes('dsh plugin --profile web'), '自建 profile CLI 示例')
  assert.ok(/仅自建\s*profile|仅适用于自建\s*profile/.test(r), 'CLI 示例明确标注仅自建 profile')
  // 报错示例代码块之外的正文不得再给出 desktop 的 CLI 安装命令
  const withoutErrorBlock = r.replace(/```[^`]*managed exclusively[^`]*```/, '')
  assert.ok(!/dsh plugin --profile desktop\s+(add|remove)/.test(withoutErrorBlock), '不再给出 desktop 的 CLI 安装/卸载命令')
  assert.ok(r.includes('API 密码'), 'FreshRSS API 密码说明')
  assert.ok(r.includes('AI'), 'AI 配置')
  assert.ok(r.includes('0600') || r.includes('权限'), '权限说明')
  assert.ok(r.includes('GPL'), '上游许可关系')
})

test('plugin-market.json：市场条目格式', () => {
  const m = JSON.parse(readFileSync(join(root, 'plugin-market.json'), 'utf8'))
  assert.equal(m.name, 'dsh-rss')
  assert.ok(m.install.includes('dsh plugin --profile'))
  assert.ok(m.description && (m.description.zh || m.description.en))
})
