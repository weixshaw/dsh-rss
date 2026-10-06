/**
 * 不可信 HTML 处理：
 * - sanitizeStoredHtml：入库前清理（移除脚本/样式/框架/事件属性/危险协议）。
 *   图片保留为**只含 src/alt 的裸 `<img>`**（src 仅 http/https，支持 data-src 回退；
 *   非法/缺失 src 退回 `［图片： …］` 文本标记）——是否真正加载由浏览器端渲染层决定：
 *   默认不加载（占位文本），开启「图片代理」后 src 重写为本地代理路由（不暴露客户端 IP）。
 *   转纯文本（AI/搜索/摘要）时图片一律回到文本标记，不会把 URL 噪声带给模型。
 * - htmlToText：供 AI 与搜索使用的纯文本。
 * 浏览器端渲染绝不使用 innerHTML，client.js 只用白名单标签构建 React 节点。
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷', eacute: 'é',
  egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', hellip_: '…',
}

export function decodeEntities(text) {
  let s = String(text ?? '')
  if (!s.includes('&')) return s
  s = s.replace(/&#x([0-9a-fA-F]{1,6});/g, (_, h) => safeCodePoint(Number.parseInt(h, 16)))
  s = s.replace(/&#(\d{1,8});/g, (_, d) => safeCodePoint(Number(d)))
  s = s.replace(/&([a-zA-Z][a-zA-Z0-9]{1,30});/g, (m, name) => {
    const v = ENTITIES[name.toLowerCase()]
    return v !== undefined ? v : m
  })
  return s
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '\uFFFD'
  try {
    return String.fromCodePoint(code)
  } catch {
    return '\uFFFD'
  }
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 移除注释与危险元素块（含未闭合的开标签）。 */
const DROP_BLOCK = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'svg', 'math',
  'form', 'link', 'meta', 'base', 'frame', 'frameset', 'applet', 'canvas', 'template',
])

const IMG_MARKER_MAX = 120

function attrValue(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  if (!m) return null
  const v = m[1] ?? m[2] ?? m[3] ?? ''
  return v !== '' ? decodeEntities(v) : null
}

/** 仅放行 http/https 的绝对图片地址（相对/协议相对/其它协议一律拒绝）。 */
function safeImgSrc(raw) {
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

/** 把原始 <img> 重建为只含校验过的 src/alt 的裸标签；无合法 src 时退回文本标记。 */
function rebuildImg(attrs) {
  const alt = clampTo(attrValue(attrs, 'alt'), IMG_MARKER_MAX)
  // 懒加载源站常见 src 占位 + data-src 真图：优先 data-src（src 常是 1px 占位图）
  const src = safeImgSrc(attrValue(attrs, 'data-src')) || safeImgSrc(attrValue(attrs, 'src'))
  if (!src) {
    return alt ? `［图片：${alt}］` : '［图片］'
  }
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt || '')}">`
}

function clampTo(s, max) {
  const v = String(s ?? '')
  return v.length > max ? `${v.slice(0, max)}…` : v
}

/** 纯文本语境（AI/搜索/摘要）的图片标记：alt 优先、src 兜底。 */
function imgMarker(attrs) {
  const label = clampTo(attrValue(attrs, 'alt') || attrValue(attrs, 'src') || '', IMG_MARKER_MAX)
  return `［图片${label ? `：${label}` : ''}］`
}

/**
 * 入库清理：输出仍被视为不可信数据（浏览器端还有第二层白名单渲染），
 * 但保证其中不含可执行脚本、事件属性与危险协议；图片只剩校验过的 src/alt。
 */
export function sanitizeStoredHtml(input, maxLen = 600 * 1024) {
  let s = String(input ?? '')
  if (!s) return ''
  // 注释与 CDATA 包装
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  // 危险元素整块移除（闭合与自闭合两种形态）
  for (const tag of DROP_BLOCK) {
    const paired = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}\\s*>`, 'gi')
    s = s.replace(paired, '')
    const lone = new RegExp(`<${tag}(?:\\s[^>]*)?/?>`, 'gi')
    s = s.replace(lone, '')
  }
  // 图片重建为裸 <img src alt>（src 仅 http/https；加载与否由渲染层决定）；无合法 src 退回文本标记
  s = s.replace(/<img\b([^>]*)\/?>/gi, (_, attrs) => rebuildImg(attrs))
  // 事件属性
  s = s.replace(/\son[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  // 危险协议的 href/src
  s = s.replace(/\s(?:href|src)\s*=\s*(?:"\s*(?:javascript|vbscript|data)\s*:[^"]*"|'\s*(?:javascript|vbscript|data)\s*:[^']*'|(?:javascript|vbscript|data)\s*:[^\s>]*)/gi, '')
  if (s.length > maxLen) s = `${s.slice(0, maxLen)}…`
  return s.trim()
}

/** 转纯文本：保留段落换行与图片标记，解码实体。 */
export function htmlToText(input, maxLen = 12000) {
  let s = String(input ?? '')
  if (!s) return ''
  s = s.replace(/<img\b([^>]*)\/?>/gi, (_, attrs) => ` ${imgMarker(attrs)} `)
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(?:p|div|section|article|li|ul|ol|h[1-6]|tr|table|blockquote|pre|header|footer)>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  s = s.replace(/[ \t\u00a0]+/g, ' ')
  s = s.replace(/\n{3,}/g, '\n\n')
  s = s.replace(/^[ \t]+|[ \t]+$/gm, '')
  if (s.length > maxLen) s = `${s.slice(0, maxLen)}…`
  return s.trim()
}

/** 纯文本摘要（首段优先）。 */
export function textExcerpt(text, maxLen = 200) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= maxLen) return s
  return `${s.slice(0, maxLen)}…`
}
