import { sanitizeStoredHtml } from './sanitize.js'
import { clampStr } from './util.js'

/**
 * 抓取原文页面的正文提取（「抓取全文」功能，服务摘要型/截断型订阅）：
 * 独立实现的轻量 readability——不追求完美，只求常见的语义化页面（博客/新闻/公众号）
 * 拿到干净的正文 HTML。流程：
 *   1. 去注释；优先取 `<article>`（文字量足够时），否则取 `<body>`，再否则整体；
 *   2. 整块移除导航性/干扰性元素（script/style/nav/header/footer/aside/form/iframe/svg 等）；
 *   3. 复用入库清理（图片保留裸 img src/alt、危险协议/事件属性清除、长度钳制）。
 * 输出仍走浏览器端白名单渲染，全程按不可信数据处理。
 */

const JUNK_TAGS = [
  'script', 'style', 'noscript', 'iframe', 'frame', 'svg', 'math', 'form',
  'nav', 'header', 'footer', 'aside', 'button', 'input', 'select', 'textarea',
  'template', 'applet', 'object', 'embed',
]

/** 粗略文字量（去标签后的可见字符数），用于判断候选块是否够“正文”。 */
function textVolume(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length
}

function dropBlocks(html) {
  let s = String(html ?? '')
  for (const tag of JUNK_TAGS) {
    const paired = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}\\s*>`, 'gi')
    s = s.replace(paired, '')
    const lone = new RegExp(`<${tag}(?:\\s[^>]*)?/?>`, 'gi')
    s = s.replace(lone, '')
  }
  return s
}

/**
 * @param {string} rawHtml 原始页面 HTML
 * @param {number} minArticleChars 使用 <article> 块的最低文字量（过小说明只是页面小部件）
 * @returns {string} 清理后的正文 HTML（可能为空串 = 未能提取）
 */
export function extractReadableHtml(rawHtml, { minArticleChars = 200, maxLen = 600 * 1024 } = {}) {
  let s = String(rawHtml ?? '')
  if (!s) return ''
  s = s.replace(/<!--[\s\S]*?-->/g, '')

  // 优先 <article>（取第一个文字量达标的；多个 article 时选文字量最大的更稳）
  const articles = [...s.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)].map((m) => m[1])
  if (articles.length) {
    const best = articles.reduce((a, b) => (textVolume(b) > textVolume(a) ? b : a))
    if (textVolume(best) >= minArticleChars) s = best
  }

  // 无可用 article → 取 <body>
  if (!articles.length || textVolume(s) < minArticleChars) {
    const body = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(s)
    const candidate = body ? body[1] : s
    if (textVolume(candidate) > textVolume(s)) s = candidate
  }

  s = dropBlocks(s)
  const clean = sanitizeStoredHtml(s, maxLen)
  // 提取结果文字量过低（如登录墙/纯 JS 渲染页）→ 明确按“没提到”处理
  return textVolume(clean) >= 40 ? clean : ''
}

/** 提取结果的可见摘要（调试/消息用）。 */
export function fulltextExcerpt(html, len = 120) {
  return clampStr(String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), len)
}
