import { RssError } from './util.js'
import { sanitizeStoredHtml, htmlToText } from './sanitize.js'

/**
 * FreshRSS Google Reader 兼容 API 客户端。
 * 协议依据 FreshRSS 官方文档与 p/api/greader.php 实现（2026-10 拉取核对）：
 * - 登录：POST {api}/accounts/ClientLogin  body: Email=…&Passwd=…（API 密码）
 *   → 文本响应含 `Auth=…`；后续请求头 `Authorization: GoogleLogin auth=<Auth>`。
 * - 写操作令牌：GET {api}/reader/api/0/token → 纯文本令牌。
 * - 订阅列表：GET {api}/reader/api/0/subscription/list?output=json。
 * - 条目流：GET {api}/reader/api/0/stream/contents/{streamId}?output=json&n=&xt=&c=
 *   （c 为上一页返回的 continuation 数字串；reading-list / feed/<id> / user/-/label/<名>）。
 * - 读/星标写入：POST {api}/reader/api/0/edit-tag  body: i=<条目>&a=<标签>&r=<标签>&ac=edit&T=<令牌>。
 * - 全部已读：POST {api}/reader/api/0/mark-all-as-read  body: s=<流>&ts=<纳秒时间戳>&T=<令牌>。
 * 所有请求：仅 http/https、超时 12s、响应上限 1MB；一律 redirect:'error'（所有请求都携带凭据——
 * ClientLogin 带密码、其余带 Auth 令牌——拒绝任何重定向，杜绝跨源凭据转发）。
 * 错误消息不包含密码与 Auth 令牌。
 */

export class GreaderError extends RssError {
  constructor(message, { status = 0 } = {}) {
    super(message, { status })
    this.name = 'GreaderError'
  }
}

const READ_TAG = 'user/-/state/com.google/read'
const STAR_TAG = 'user/-/state/com.google/starred'

/** 规范化 API 基址：接受站点根地址 / …/api / …/api/greader.php。 */
export function normalizeApiBase(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) throw new GreaderError('FreshRSS 地址为空')
  let u
  try {
    u = new URL(s)
  } catch {
    throw new GreaderError('FreshRSS 地址不合法')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new GreaderError('FreshRSS 地址仅支持 http/https')
  }
  if (!/\/greader\.php$/i.test(s)) s = /\/api$/i.test(s) ? `${s}/greader.php` : `${s}/api/greader.php`
  return { base: s, insecure: u.protocol === 'http:' }
}

function formEncode(pairs) {
  const sp = new URLSearchParams()
  for (const [k, v] of pairs) sp.append(k, v)
  return sp.toString()
}

export class GreaderClient {
  constructor({ baseUrl, username, apiPassword, fetchImpl }) {
    const { base, insecure } = normalizeApiBase(baseUrl)
    this.base = base
    this.insecure = insecure
    this.username = String(username || '').trim()
    this.apiPassword = String(apiPassword || '')
    this.fetch = fetchImpl
    this.auth = null
    if (!this.username) throw new GreaderError('FreshRSS 用户名为空')
    if (!this.apiPassword) throw new GreaderError('FreshRSS API 密码为空')
  }

  async request(path, { method = 'GET', body = null, headers = {}, timeoutMs = 12000 } = {}) {
    if (!this.fetch) throw new GreaderError('未注入 fetchImpl（内部错误）')
    let res
    try {
      res = await this.fetch(`${this.base}${path}`, {
        method,
        headers,
        body,
        timeoutMs,
        maxBytes: 1024 * 1024,
        // 所有请求都带凭据（ClientLogin 带密码，其余带 Auth 令牌）：
        // 一律拒绝重定向，杜绝凭据被跨源转发
        redirect: 'error',
      })
    } catch (err) {
      throw new GreaderError(`FreshRSS 请求失败：${err?.message || '网络错误'}`, { status: err?.extra?.status || 0 })
    }
    if (res.status === 401) throw new GreaderError('FreshRSS 认证失败（检查用户名与 API 密码，以及是否已开启 API）', { status: 401 })
    if (!res.ok && res.status !== 400) throw new GreaderError(`FreshRSS HTTP ${res.status}`, { status: res.status })
    return res
  }

  /** ClientLogin，取得 Auth 令牌。 */
  async login() {
    const res = await this.request('/accounts/ClientLogin', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formEncode([['Email', this.username], ['Passwd', this.apiPassword]]),
    })
    const m = /^Auth=(.+)$/m.exec(res.text || '')
    if (!m) throw new GreaderError('ClientLogin 响应中没有 Auth 令牌（服务端可能未启用 Google Reader API）', { status: res.status })
    this.auth = m[1].trim()
    return { insecure: this.insecure }
  }

  authHeaders() {
    if (!this.auth) throw new GreaderError('尚未登录（先调用 login）')
    return { authorization: `GoogleLogin auth=${this.auth}` }
  }

  /** 写操作令牌（/reader/api/0/token）。 */
  async token() {
    const res = await this.request('/reader/api/0/token', { headers: this.authHeaders() })
    const t = (res.text || '').trim().replace(/^"|"$/g, '')
    if (!t) throw new GreaderError('未取得写操作令牌（token 为空）')
    return t
  }

  /** 订阅列表。 */
  async subscriptionList() {
    const res = await this.request('/reader/api/0/subscription/list?output=json', { headers: this.authHeaders() })
    let data
    try {
      data = JSON.parse(res.text)
    } catch {
      throw new GreaderError('订阅列表响应不是 JSON', { status: res.status })
    }
    const subs = Array.isArray(data?.subscriptions) ? data.subscriptions : []
    return subs.map((s) => ({
      externalFeedId: String(s.id || ''),
      title: String(s.title || s.url || s.id || ''),
      url: String(s.url || s.htmlUrl || ''),
      siteUrl: String(s.htmlUrl || ''),
      group: Array.isArray(s.categories) && s.categories.length ? String(s.categories[0].label || '') : '',
    })).filter((s) => s.externalFeedId)
  }

  /**
   * 条目流（分页抓取）。
   * @param {string} streamId 例如 'user/-/state/com.google/reading-list'、'feed/12'
   * @param {object} opts n=每页条数；xt=排除标签；ot=起始时间戳（秒，只拉这之后的新条目，增量同步用）；
   *                      maxPages=最多页数（1-8）
   */
  async streamContents(streamId, { n = 50, xt, ot, maxPages = 1 } = {}) {
    const items = []
    let continuation = null
    for (let page = 0; page < Math.max(1, Math.min(maxPages, 8)); page++) {
      const q = new URLSearchParams({ output: 'json', n: String(n) })
      if (xt) q.set('xt', xt)
      if (ot) q.set('ot', String(ot))
      if (continuation) q.set('c', continuation)
      const path = `/reader/api/0/stream/contents/${streamId.split('/').map(encodeURIComponent).join('/')}?${q.toString()}`
      const res = await this.request(path, { headers: this.authHeaders() })
      let data
      try {
        data = JSON.parse(res.text)
      } catch {
        throw new GreaderError('条目流响应不是 JSON', { status: res.status })
      }
      if (Array.isArray(data?.items)) items.push(...data.items)
      continuation = data?.continuation ? String(data.continuation) : null
      if (!continuation) break
    }
    return { items, pages: continuation ? 'more' : 'done' }
  }

  /** 写入读/星标状态（edit-tag，重复 i/a/r）。 */
  async editTags({ ids, add = [], remove = [] }) {
    if (!ids?.length) return { ok: true, count: 0 }
    const t = await this.token()
    const pairs = [['T', t], ['ac', 'edit']]
    for (const id of ids) pairs.push(['i', String(id)])
    for (const tag of add) pairs.push(['a', tag])
    for (const tag of remove) pairs.push(['r', tag])
    const res = await this.request('/reader/api/0/edit-tag', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...this.authHeaders() },
      body: formEncode(pairs),
    })
    if (!/OK/i.test(res.text || '')) {
      throw new GreaderError('FreshRSS 拒绝了状态写入（edit-tag 未返回 OK）', { status: res.status })
    }
    return { ok: true, count: ids.length }
  }

  /** 全部标记已读（mark-all-as-read，ts 为纳秒）。 */
  async markAllRead(streamId, olderThanMs = Date.now()) {
    const t = await this.token()
    const res = await this.request('/reader/api/0/mark-all-as-read', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...this.authHeaders() },
      body: formEncode([['T', t], ['s', streamId], ['ts', String(Math.trunc(olderThanMs * 1e6))]]),
    })
    if (!/OK/i.test(res.text || '')) {
      throw new GreaderError('FreshRSS 拒绝了全部已读（mark-all-as-read 未返回 OK）', { status: res.status })
    }
    return { ok: true }
  }
}

/** 仅放行 http/https 链接（远端数据不可信，拒绝 javascript:/data: 等）。 */
function safeHttpUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

/** Google Reader 条目 → 本地文章结构。id/分类字段按原文透传（不猜格式）；链接仅保留 http/https。 */
export function greaderItemToArticle(item) {
  const categories = Array.isArray(item?.categories) ? item.categories.map(String) : []
  const read = categories.includes(READ_TAG)
  const starred = categories.includes(STAR_TAG)
  const content = String(item?.summary?.content ?? item?.content?.content ?? '')
  const clean = sanitizeStoredHtml(content)
  const url = safeHttpUrl(item?.canonical?.[0]?.href || item?.alternate?.[0]?.href)
  const publishedMs = Number.isFinite(item?.published) ? item.published * 1000 : null
  const updatedMs = Number.isFinite(item?.updated) ? item.updated * 1000 : publishedMs
  return {
    externalId: String(item?.id ?? ''),
    title: String(item?.title || url || '(无标题)'),
    url,
    publishedMs,
    updatedMs,
    author: item?.author ? String(item.author) : null,
    summaryHtml: clean,
    contentHtml: clean,
    contentText: htmlToText(clean, 12000),
    enclosureUrl: safeHttpUrl(item?.enclosure?.[0]?.href),
    enclosureType: item?.enclosure?.[0]?.type ? String(item.enclosure[0].type) : null,
    greader: { read, starred, originStreamId: String(item?.origin?.streamId || '') },
  }
}

export const GREADER_TAGS = { READ: READ_TAG, STAR: STAR_TAG }
