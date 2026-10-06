#!/usr/bin/env node
/**
 * 打包/静态检查门禁（npm run check）：
 * 1. 对全部 .js 文件跑 `node --check`（语法门禁）；
 * 2. 动态 import 所有 lib 模块与 host 入口（加载门禁，含依赖解析）；
 * 3. 校验 DSH 插件清单（package.json 的 dsh 字段、exports、files）；
 * 4. 校验 cordis.patch.yml 挂载行；
 * 5. 校验 README 关键内容（安装命令 / FreshRSS API 密码 / AI BYOK 说明）。
 * 任一失败以非零码退出。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const ok = (msg) => console.log(`  ✓ ${msg}`)
const bad = (msg) => { problems.push(msg); console.error(`  ✗ ${msg}`) }

// 1) 语法检查
console.log('[1/6] node --check 全部 JS 文件')
const jsFiles = ['index.js', 'client.js', ...readdirSync(join(root, 'lib')).map((f) => `lib/${f}`)]
for (const rel of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', join(root, rel)], { encoding: 'utf8' })
  if (r.status === 0) ok(rel)
  else bad(`${rel} 语法错误: ${(r.stderr || '').split('\n')[0]}`)
}

// 2) 模块加载（lib + host 入口）
console.log('[2/6] 动态 import 模块')
for (const rel of ['index.js', ...readdirSync(join(root, 'lib')).map((f) => `lib/${f}`)]) {
  try {
    await import(join(root, rel))
    ok(rel)
  } catch (err) {
    if (rel === 'index.js' && /ERR_MODULE_NOT_FOUND.*dsh-tools/.test(String(err))) {
      // peer 依赖缺失时的回退路径在运行时处理；这里不允许加载失败
      bad(`index.js 加载失败: ${err.message}`)
    } else {
      bad(`${rel} 加载失败: ${err.message}`)
    }
  }
}

// 3) DSH 插件清单
console.log('[3/6] package.json 清单')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const expect = (cond, msg) => (cond ? ok(msg) : bad(msg))
expect(pkg.name === 'dsh-rss', 'name = dsh-rss')
expect(pkg.type === 'module', 'type = module')
expect(pkg.main === 'index.js' && existsSync(join(root, pkg.main)), 'main → index.js 存在')
expect(pkg.exports?.['./client'] === './client.js' && existsSync(join(root, 'client.js')), 'exports["./client"] → client.js 存在')
expect(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch → cordis.patch.yml')
expect(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform = web')
expect(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0, `dsh.client.inject 非空 (${pkg.dsh.client.inject.join(', ')})`)
expect(pkg.dsh?.manifestVersion === 1, 'dsh.manifestVersion = 1')
expect(pkg.peerDependencies?.['@deepseek-ai/dsh-tools'] !== undefined, 'peer: @deepseek-ai/dsh-tools')
expect(Array.isArray(pkg.files) && ['index.js', 'client.js', 'cordis.patch.yml', 'README.md'].every((f) => pkg.files.includes(f)), 'files 覆盖 index/client/patch/README')
expect(pkg.scripts?.test === 'node --test', 'scripts.test')
expect(pkg.scripts?.check === 'node scripts/check.js', 'scripts.check')

// 4) 客户端/宿主版本一致性（CLIENT_VERSION 用于「宿主旧、客户端新」检测，漂移会让提示误报）
console.log('[4/6] client.js 版本一致性')
const clientSrc = readFileSync(join(root, 'client.js'), 'utf8')
const cvMatch = /CLIENT_VERSION = '([^']+)'/.exec(clientSrc)
expect(Boolean(cvMatch), 'client.js 应声明 CLIENT_VERSION')
expect(cvMatch?.[1] === pkg.version, `CLIENT_VERSION (${cvMatch?.[1] || '缺失'}) 应与 package.json version (${pkg.version}) 一致`)

// 4) Cordis patch 挂载行
console.log('[4/6] cordis.patch.yml')
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
expect(/-\s*insert:/.test(patch), '包含 - insert:')
expect(/id:\s*dsh-rss\b/.test(patch), 'id: dsh-rss')
expect(/name:\s*'?dsh-rss'?/.test(patch), "name: 'dsh-rss'")

// 5) README 关键内容
console.log('[5/6] README 关键内容')
const readme = readFileSync(join(root, 'README.md'), 'utf8')
expect(readme.includes('添加插件') && readme.includes('github.com/phantasy/dsh-rss'), 'GUI 安装：添加插件 + Git 仓库地址')
expect(readme.includes('managed exclusively by the Electron application'), 'desktop profile 的 CLI 拒绝说明（Electron 独占管理）')
expect(readme.includes('dsh plugin --profile web') && readme.includes('自建 profile'), '自建 profile（如 web）的 CLI 示例且明确标注适用范围')
expect(readme.includes('API 密码'), '包含 FreshRSS API 密码说明')
expect(readme.includes('AI'), '包含 AI 配置说明')
expect(readme.includes('硬刷新') || readme.includes('Cmd/Ctrl+Shift+R'), '包含重启/硬刷新说明')
expect(readme.includes('GPL'), '包含与 qiaomu-ai-rss 的许可关系说明')

console.log('')
console.log('[6/6] 完成')
if (problems.length) {
  console.error(`check: ${problems.length} 项未通过`)
  process.exit(1)
}
console.log('check: 全部通过')
