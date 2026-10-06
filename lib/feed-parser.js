import { RssError, clampStr, parseDateMs } from './util.js'
import { decodeEntities, sanitizeStoredHtml, htmlToText } from './sanitize.js'

/**
 * 独立实现的 RSS 2.0 / RDF / Atom 解析器（零依赖）。
 * 只做尽力解析：CDATA、命名空间前缀（content:encoded / dc:date / dc:creator）、
 * 常用实体解码、RFC822/ISO 日期。所有 HTML 字段入库前先 sanitize。
 */

const MAX_ITEMS = 200

function stripCdata(s) {
  return String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

function attrsOf(openTag) {
  return openTag.slice(openTag.indexOf('<') + 1).replace(/^[^\s>]+\s*/, '')
}

/** 在片段中取第一个匹配标签（支持命名空间前缀）的内容文本。 */
function pickContent(fragment, localName) {
  const re = new RegExp(`<(?:[A-Za-z][-A-Za-z0-9]*:)?${localName}(\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z][-A-Za-z0-9]*:)?${localName}\\s*>`, 'i')
  const m = re.exec(fragment)
  if (!m) return null
  const raw = stripCdata(m[2])
  return decodeEntities(raw).trim() || null
}

/** 取第一个匹配标签上的属性值。 */
function pickAttr(fragment, localName, attr) {
  const re = new RegExp(`<(?:[A-Za-z][-A-Za-z0-9]*:)?${localName}(\\s[^>]*)?/?>`, 'i')
  const m = re.exec(fragment)
  if (!m) return null
  const attrs = m[1] || ''
  const are = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i')
  const am = are.exec(attrs)
  if (!am) return null
  return decodeEntities(am[1] ?? am[2] ?? '').trim() || null
}

/** 提取 <tag>…</tag> 的片段数组（按出现顺序，不做嵌套假设）。 */
function splitBlocks(xml, localName) {
  const openRe = new RegExp(`<(?:[A-Za-z][-A-Za-z0-9]*:)?${localName}(?:\\s[^>]*)?>`, 'i')
  const closeRe = new RegExp(`</(?:[A-Za-z][-A-Za-z0-9]*:)?${localName}\\s*>`, 'i')
  const out = []
  let i = 0
  while (out.length < MAX_ITEMS) {
    const o = openRe.exec(xml.slice(i))
    if (!o) break
    const start = i + o.index + o[0].length
    const c = closeRe.exec(xml.slice(start))
    if (!c) {
      // 未闭合：取到下一个开标签或结尾
      const next = openRe.exec(xml.slice(start))
      const end = next ? start + next.index : Math.min(xml.length, start + 20000)
      out.push(xml.slice(start, end))
      i = end
      continue
    }
    const end = start + c.index + c[0].length
    out.push(xml.slice(start, end))
    i = end
  }
  return out
}

function atomLink(fragment) {
  // 优先 rel="alternate"，否则第一个带 href 的 link
  const links = []
  const re = /<(?:[A-Za-z][-A-Za-z0-9]*:)?link(\s[^>]*)?\/?>/gi
  let m
  while ((m = re.exec(fragment)) !== null) {
    const attrs = m[1] || ''
    const rel = (attrs.match(/rel\s*=\s*(?:"([^"]*)"|'([^']*)')/i) || []).slice(1).find((v) => v != null)
    const href = (attrs.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i) || []).slice(1).find((v) => v != null)
    const type = (attrs.match(/type\s*=\s*(?:"([^"]*)"|'([^']*)')/i) || []).slice(1).find((v) => v != null)
    if (href) links.push({ rel: rel || 'alternate', href: decodeEntities(href), type: type || '' })
  }
  if (!links.length) return null
  return (links.find((l) => l.rel === 'alternate' && (!l.type || /html/i.test(l.type))) || links[0]).href
}

function safeUrl(raw) {
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

function buildItem(fragment, kind, index) {
  const titleRaw = pickContent(fragment, 'title')
  let url = null
  let externalId = null
  let publishedMs = null
  let updatedMs = null
  let author = null
  let summaryHtml = ''
  let contentHtml = ''
  let enclosureUrl = null
  let enclosureType = null

  if (kind === 'rss') {
    // RSS: <link>text</link>；Atom 内嵌的 link 由 atomLink 处理不到，忽略
    const linkText = pickContent(fragment, 'link')
    url = safeUrl(stripCdata(linkText || '')) || null
    externalId = pickContent(fragment, 'guid')
    const dateRaw = pickContent(fragment, 'pubDate') || pickContent(fragment, 'date')
    publishedMs = parseDateMs(dateRaw)
    updatedMs = publishedMs
    author = pickContent(fragment, 'creator') || pickContent(fragment, 'author')
    summaryHtml = pickContent(fragment, 'description') || ''
    contentHtml = pickContent(fragment, 'encoded') || summaryHtml
    const encAttrs = (() => {
      const re = /<(?:[A-Za-z][-A-Za-z0-9]*:)?enclosure(\s[^>]*)?\/?>/i
      const m = re.exec(fragment)
      return m ? m[1] || '' : null
    })()
    if (encAttrs != null) {
      enclosureUrl = safeUrl(((encAttrs.match(/url\s*=\s*(?:"([^"]*)"|'([^']*)')/i) || []).slice(1).find((v) => v != null)) || '')
      enclosureType = ((encAttrs.match(/type\s*=\s*(?:"([^"]*)"|'([^']*)')/i) || []).slice(1).find((v) => v != null)) || null
    }
  } else {
    url = safeUrl(atomLink(fragment)) || null
    externalId = pickContent(fragment, 'id')
    publishedMs = parseDateMs(pickContent(fragment, 'published'))
    updatedMs = parseDateMs(pickContent(fragment, 'updated')) ?? publishedMs
    if (publishedMs == null && updatedMs != null) publishedMs = updatedMs
    author = pickContent(fragment, 'name') || pickContent(fragment, 'author') || pickContent(fragment, 'email')
    summaryHtml = pickContent(fragment, 'summary') || ''
    contentHtml = pickContent(fragment, 'content') || summaryHtml
    if (!enclosureUrl) {
      // Atom enclosure 链接
      const re = /<(?:[A-Za-z][-A-Za-z0-9]*:)?link(\s[^>]*)?\/?>/gi
      let m
      while ((m = re.exec(fragment)) !== null) {
        const attrs = m[1] || ''
        const rel = (attrs.match(/rel\s*=\s*(?:"([^"]*)"|'([^']*)')/i) || []).slice(1).find((v) => v != null)
        if (rel === 'enclosure') {
          enclosureUrl = safeUrl(((attrs.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i) || []).slice(1).find((v) => v != null)) || '')
          enclosureType = (attrs.match(/type\s*=\s*(?:"([^"]*)"|'([^']*)')/i) || []).slice(1).find((v) => v != null) || null
          break
        }
      }
    }
  }

  const cleanContent = sanitizeStoredHtml(contentHtml)
  const cleanSummary = sanitizeStoredHtml(summaryHtml) || cleanContent
  return {
    externalId: clampStr(externalId || url || titleRaw || `item-${index}`, 500),
    title: clampStr(titleRaw || url || '(无标题)', 500),
    url,
    publishedMs,
    updatedMs,
    author: author ? clampStr(author, 200) : null,
    summaryHtml: cleanSummary,
    contentHtml: cleanContent,
    contentText: htmlToText(cleanContent || cleanSummary, 12000),
    enclosureUrl,
    enclosureType,
  }
}

/**
 * 解析 RSS/Atom 文本。
 * @returns {{kind:'rss'|'atom', title:string, siteUrl:string|null, description:string, items:Array}}
 */
export function parseFeed(xmlText) {
  let xml = String(xmlText ?? '')
  if (!xml) throw new RssError('订阅源内容为空')
  xml = xml.replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, '')
  const head = xml.slice(0, 4096)

  let kind = null
  if (/<rss[\s>]/i.test(head) || /<rdf:RDF[\s>]/i.test(head)) kind = 'rss'
  else if (/<feed[\s>]/i.test(head)) kind = 'atom'
  if (!kind) throw new RssError('无法识别的订阅源格式（不是 RSS/Atom）')

  // 频道级元数据：RSS 取 <channel>，Atom 取 <feed> 根
  let channelXml = xml
  if (kind === 'rss') {
    const ch = /<channel(?:\s[^>]*)?>([\s\S]*?)<\/channel\s*>/i.exec(xml)
    if (ch) channelXml = ch[1]
  } else {
    const firstItem = splitBlocks(xml, 'entry')[0]
    channelXml = firstItem ? xml.slice(0, xml.indexOf(firstItem)) : xml
  }
  const feedTitle = pickContent(channelXml, 'title') || ''
  const siteUrl = kind === 'atom' ? safeUrl(atomLink(channelXml)) : safeUrl(stripCdata(pickContent(channelXml, 'link') || ''))
  const description = clampStr(pickContent(channelXml, 'description') || pickContent(channelXml, 'subtitle') || '', 500)

  const blocks = splitBlocks(xml, kind === 'rss' ? 'item' : 'entry')
  const items = blocks.map((b, i) => buildItem(b, kind, i))
  return {
    kind,
    title: clampStr(feedTitle, 300) || '(未命名订阅)',
    siteUrl,
    description,
    items,
  }
}
