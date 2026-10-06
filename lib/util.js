import { createHash } from 'node:crypto'

/** 通用工具：稳定 ID、URL 规范化、数值钳制、日期解析、错误脱敏。 */

export function sha1(input) {
  return createHash('sha1').update(String(input), 'utf8').digest('hex')
}

export class RssError extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.name = 'RssError'
    this.extra = extra
  }
}

/**
 * 规范化订阅源 URL：仅允许 http/https；去 hash、去默认端口、统一小写主机、
 * 去末尾斜杠（根路径除外）。用于去重与存储统一形态。
 * 返回规范化后的字符串；不合法时抛出 RssError。
 */
export function normalizeFeedUrl(raw) {
  let u
  try {
    u = new URL(String(raw || '').trim())
  } catch {
    throw new RssError('URL 不合法')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new RssError('仅支持 http/https 协议的订阅地址')
  }
  u.hash = ''
  u.hostname = u.hostname.toLowerCase()
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = ''
  }
  let s = u.toString()
  if (s.endsWith('/') && u.pathname !== '/' && u.pathname !== '') {
    s = s.slice(0, -1)
  }
  if (s.endsWith('//')) s = s.slice(0, -1)
  return s
}

/** 判断 URL 是否明文 http（用于 UI 警告）。解析失败返回 false。 */
export function isInsecureHttpUrl(raw) {
  try {
    return new URL(String(raw)).protocol === 'http:'
  } catch {
    return false
  }
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export function clampStr(value, max) {
  const s = String(value ?? '')
  return s.length > max ? s.slice(0, max) : s
}

/** 尽力解析日期为毫秒时间戳；失败返回 null。 */
export function parseDateMs(raw) {
  if (raw == null) return null
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw)
  const s = String(raw).trim()
  if (!s) return null
  const t = Date.parse(s)
  if (Number.isFinite(t)) return t
  // 兼容 "2026-01-02T03:04:05" 无时区（按本地时间）与纯数字时间戳
  const t2 = Date.parse(s.length === 19 && !/[zZ+]|GMT/.test(s) ? `${s}Z` : s)
  if (Number.isFinite(t2)) return t2
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s)
    return s.length === 13 ? n : n * 1000
  }
  return null
}

/** 把任意错误压成单行、有界长度且不泄露敏感内容的消息。 */
export function redactMessage(err, maxLen = 240) {
  let msg
  if (err instanceof Error) msg = err.message
  else msg = String(err ?? '未知错误')
  msg = msg.split('\n').map((l) => l.trim()).filter(Boolean).join(' ') || '未知错误'
  if (msg.length > maxLen) msg = `${msg.slice(0, maxLen)}…`
  return msg
}

/** 文章稳定 ID：订阅键 + 条目外部 ID（guid/链接/标题兜底）。 */
export function stableEntryId(feedKey, externalId) {
  return sha1(`${feedKey}\u0000${externalId ?? ''}`)
}

export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 深合并配置补丁（仅覆盖出现过的键）。 */
export function mergeConfig(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue
    if (isPlainObject(out[k]) && isPlainObject(v)) out[k] = mergeConfig(out[k], v)
    else out[k] = v
  }
  return out
}
