import { mkdir, readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { RssError, clampStr, mergeConfig, isInsecureHttpUrl } from './util.js'

/**
 * 配置读写：全部落在插件状态目录（默认 $DSH_HOME/dsh-rss，可用 DSH_RSS_HOME 覆盖）。
 * - 文件权限 0600，目录 0700，原子写入（pid+时间戳+随机的 tmp + rename，失败清理 tmp）；
 * - 同一目录的读-改-写事务通过 withConfigLock 串行化（并发补丁不丢更新）；
 * - 配置文件损坏时显式报错，不静默重置；
 * - 敏感字段（FreshRSS API 密码、AI API Key）对浏览器/工具只回传“是否已配置”布尔（write-only）；
 * - FreshRSS 账号身份（accountKey = 规范化基址 + 用户名）：变更时置 needsReset，
 *   用户显式确认重置前连接/同步一律失败关闭，防止把 A 账号的待推送状态写到 B 账号。
 */

export function resolveStateDir(env = process.env) {
  if (env.DSH_RSS_HOME && String(env.DSH_RSS_HOME).trim()) {
    return String(env.DSH_RSS_HOME).trim()
  }
  const dshHome = env.DSH_HOME && String(env.DSH_HOME).trim() ? String(env.DSH_HOME).trim() : join(homedir(), '.dsh')
  return join(dshHome, 'dsh-rss')
}

export function defaultConfig() {
  return {
    version: 1,
    freshrss: null, // { baseUrl, username, apiPassword, enabled, accountKey, needsReset }
    ai: null,       // { baseUrl, model, apiKey, enabled }
    ui: { imageMode: 'never' },
  }
}

/**
 * FreshRSS 账号身份键：仅规范化协议（小写）、主机名（小写）与默认端口；
 * **路径与用户名保留大小写**（可能是大小写敏感的安装/用户名，不得合并）。
 * 对等规则：结尾斜杠去除；文档化的 `/api`、`/api/greader.php` 后缀与根路径视为同一安装（精确后缀，大小写敏感）。
 */
export function accountKeyOf(baseUrl, username) {
  let u
  try {
    u = new URL(String(baseUrl || '').trim())
  } catch {
    return `${String(baseUrl || '').trim()}|${String(username || '').trim()}`
  }
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = ''
  let path = u.pathname || '/'
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  if (path === '/') path = '' // 根路径与空路径等价（与 /api、/api/greader.php 的归一一致）
  if (path === '/api/greader.php' || path === '/api') path = ''
  const port = u.port ? `:${u.port}` : ''
  // u.protocol 自带冒号（如 "https:"），无需再拼 "://"
  return `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${port}${path}|${String(username || '').trim()}`
}

export async function ensureStateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  try { await chmod(dir, 0o700) } catch { /* 平台差异 */ }
}

export async function loadConfig(dir) {
  let text
  try {
    text = await readFile(join(dir, 'config.json'), 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return defaultConfig()
    throw err
  }
  try {
    return mergeConfig(defaultConfig(), JSON.parse(text))
  } catch {
    throw new RssError('配置文件损坏：config.json（请修复或删除该文件后重试）')
  }
}

export async function saveConfig(dir, config) {
  await ensureStateDir(dir)
  const file = join(dir, 'config.json')
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  try {
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    try { await chmod(tmp, 0o600) } catch { /* 尽力 */ }
    await rename(tmp, file)
  } catch (err) {
    await unlink(tmp).catch(() => { /* tmp 可能未创建 */ })
    throw err
  }
}

// 每目录一把事务锁：并发的读-改-写串行执行，避免丢失更新
const configLocks = new Map()

/**
 * 串行执行一次配置事务（fn 内部自行 读→改→saveConfig）。
 * 前一次失败不会卡死队列；本次错误上抛给调用方。
 */
export function withConfigLock(dir, fn) {
  const prev = configLocks.get(dir) || Promise.resolve()
  const run = prev.then(fn, fn)
  configLocks.set(dir, run.catch(() => { /* 链保持可用 */ }))
  return run
}

// ---------- greader 活动账号身份（独立于可空的 freshrss 配置存在） ----------

/** 读取当前“活动 greader 账号”身份（最近一次成功同步或确认重置后的账号键；无则 null）。 */
export async function loadAccount(dir) {
  try {
    const data = JSON.parse(await readFile(join(dir, 'account.json'), 'utf8'))
    return { accountKey: typeof data.accountKey === 'string' ? data.accountKey : null }
  } catch (err) {
    if (err && err.code === 'ENOENT') return { accountKey: null }
    throw err
  }
}

/** 持久化活动账号身份（0600、原子写；在账号互斥事务内调用）。 */
export async function saveAccount(dir, accountKey) {
  await ensureStateDir(dir)
  const file = join(dir, 'account.json')
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  try {
    await writeFile(tmp, `${JSON.stringify({ accountKey: accountKey ?? null })}\n`, { mode: 0o600 })
    try { await chmod(tmp, 0o600) } catch { /* 尽力 */ }
    await rename(tmp, file)
  } catch (err) {
    await unlink(tmp).catch(() => { /* tmp 可能未创建 */ })
    throw err
  }
}

/** 校验并清洗配置补丁；undefined = 保持不变，'' = 清除。 */
export function sanitizeConfigPatch(patch) {
  const out = {}
  if (patch == null) return out
  if ('freshrss' in (patch || {})) {
    const p = patch.freshrss
    if (p === null) { out.freshrss = null }
    else if (typeof p === 'object') {
      const cur = {}
      if ('baseUrl' in p) {
        const v = clampStr(p.baseUrl, 500).trim()
        if (v === '') cur.baseUrl = ''
        else {
          let u
          try { u = new URL(v) } catch { throw new RssError('FreshRSS 地址不合法') }
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new RssError('FreshRSS 地址仅支持 http/https')
          cur.baseUrl = v
        }
      }
      if ('username' in p) cur.username = clampStr(p.username, 200).trim()
      if ('apiPassword' in p) cur.apiPassword = clampStr(p.apiPassword, 500)
      if ('enabled' in p) cur.enabled = Boolean(p.enabled)
      out.freshrss = cur
    }
  }
  if ('ai' in (patch || {})) {
    const p = patch.ai
    if (p === null) { out.ai = null }
    else if (typeof p === 'object') {
      const cur = {}
      if ('baseUrl' in p) {
        const v = clampStr(p.baseUrl, 500).trim()
        if (v === '') cur.baseUrl = ''
        else {
          let u
          try { u = new URL(v) } catch { throw new RssError('AI 接口地址不合法') }
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new RssError('AI 接口地址仅支持 http/https')
          cur.baseUrl = v
        }
      }
      if ('model' in p) cur.model = clampStr(p.model, 200).trim()
      if ('apiKey' in p) cur.apiKey = clampStr(p.apiKey, 500)
      if ('enabled' in p) cur.enabled = Boolean(p.enabled)
      out.ai = cur
    }
  }
  if ('ui' in (patch || {}) && typeof patch.ui === 'object') {
    out.ui = {}
    if ('imageMode' in patch.ui) out.ui.imageMode = patch.ui.imageMode === 'proxy' ? 'proxy' : 'never'
  }
  return out
}

/** 合并补丁到现有配置（undefined 保持不变；'' 清除字符串字段）。 */
export function applyConfigPatch(current, patch) {
  const next = mergeConfig(current, patch)
  if (next.freshrss) {
    if (next.freshrss.baseUrl === '') next.freshrss.baseUrl = ''
    if (next.freshrss.username === '') next.freshrss.username = ''
    if (next.freshrss.apiPassword === '') next.freshrss.apiPassword = ''
  }
  if (next.ai) {
    if (next.ai.baseUrl === '') next.ai.baseUrl = ''
    if (next.ai.model === '') next.ai.model = ''
    if (next.ai.apiKey === '') next.ai.apiKey = ''
  }
  return next
}

/**
 * FreshRSS 账号变更检测（在配置事务内、applyConfigPatch 之后调用）：
 * 身份变化（含被清空/置 null）→ needsReset=true；换账号且未随补丁提供新密码时清掉旧 API 密码。
 * 该标志是 UI 提示；强制失败关闭由路由守卫（活动账号身份 + greader 数据存在性）执行，
 * 因此即便把 freshrss 置 null/空也不能绕过。
 */
export function applyAccountPolicy(current, patched, patchProvidedPassword) {
  const next = patched
  const f = next.freshrss
  const prevIdentity = current.freshrss?.baseUrl && current.freshrss?.username
    ? accountKeyOf(current.freshrss.baseUrl, current.freshrss.username)
    : null
  const newIdentity = f?.baseUrl && f?.username ? accountKeyOf(f.baseUrl, f.username) : null
  if (!newIdentity) {
    // 身份被清空/置 null：此前配置过账号则保持“待确认重置”（真正拦截在路由守卫）
    if (next.freshrss) next.freshrss.needsReset = Boolean(prevIdentity) || Boolean(next.freshrss.needsReset)
    return next
  }
  f.accountKey = newIdentity
  if (prevIdentity && prevIdentity !== newIdentity) {
    f.needsReset = true
    if (!patchProvidedPassword) f.apiPassword = ''
  }
  return next
}

/** 面向浏览器/工具的脱敏视图：绝不包含密钥/密码。 */
export function maskConfig(config) {
  const f = config.freshrss || null
  const a = config.ai || null
  return {
    version: config.version ?? 1,
    freshrss: f ? {
      baseUrl: f.baseUrl || '',
      username: f.username || '',
      enabled: Boolean(f.enabled),
      hasApiPassword: Boolean(f.apiPassword),
      insecureHttp: isInsecureHttpUrl(f.baseUrl || ''),
      configured: Boolean(f.baseUrl && f.username && f.apiPassword),
      needsReset: Boolean(f.needsReset),
    } : { baseUrl: '', username: '', enabled: false, hasApiPassword: false, insecureHttp: false, configured: false, needsReset: false },
    ai: a ? {
      baseUrl: a.baseUrl || '',
      model: a.model || '',
      enabled: Boolean(a.enabled),
      hasApiKey: Boolean(a.apiKey),
      insecureHttp: isInsecureHttpUrl(a.baseUrl || ''),
      configured: Boolean(a.baseUrl && a.model && a.apiKey),
    } : { baseUrl: '', model: '', enabled: false, hasApiKey: false, insecureHttp: false, configured: false },
    ui: { imageMode: config.ui?.imageMode === 'proxy' ? 'proxy' : 'never' },
  }
}
