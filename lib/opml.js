import { clampStr } from './util.js'
import { decodeEntities, escapeHtml } from './sanitize.js'
import { normalizeFeedUrl, RssError } from './util.js'

/**
 * OPML 导入/导出（支持嵌套分组）与按规范化 URL 去重。独立实现，零依赖。
 */

const MAX_OUTLINES = 2000

function attrOf(openTag, name) {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i')
  const m = re.exec(openTag)
  if (!m) return null
  return decodeEntities(m[1] ?? m[2] ?? '').trim() || null
}

/**
 * 解析 OPML 文本 → { feeds: [{title, xmlUrl, htmlUrl, group}] }。
 * group 为 '/' 连接的嵌套目录路径；无目录的条目 group 为 ''。
 * 非法条目（缺 xmlUrl / 非白名单协议）跳过并计入 skipped。
 */
export function parseOpml(xmlText) {
  const xml = String(xmlText ?? '').replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, '')
  if (!/<opml[\s>]/i.test(xml)) throw new RssError('不是有效的 OPML 文件（缺少 <opml> 根元素）')
  const feeds = []
  let skipped = 0
  const stack = [] // 分组名栈
  let count = 0
  const tokenRe = /<outline\b[^>]*?\/?>|<\/outline\s*>/gi
  let m
  while ((m = tokenRe.exec(xml)) !== null) {
    if (++count > MAX_OUTLINES * 2) break
    const tok = m[0]
    if (/^<\/outline/i.test(tok)) {
      stack.pop()
      continue
    }
    const selfClose = /\/>$/.test(tok)
    const xmlUrl = attrOf(tok, 'xmlUrl')
    if (xmlUrl) {
      try {
        const normalized = normalizeFeedUrl(xmlUrl)
        feeds.push({
          title: clampStr(attrOf(tok, 'title') || attrOf(tok, 'text') || normalized, 300),
          xmlUrl: normalized,
          htmlUrl: (() => { const h = attrOf(tok, 'htmlUrl'); try { return h ? normalizeFeedUrl(h) : null } catch { return null } })(),
          group: clampStr(stack.filter(Boolean).join('/'), 300),
        })
      } catch {
        skipped++
      }
    } else if (!selfClose) {
      stack.push(attrOf(tok, 'text') || attrOf(tok, 'title') || '')
    }
  }
  return { feeds, skipped }
}

/** 按规范化 URL 去重（保留首个，统计重复数）。 */
export function dedupeFeeds(list) {
  const seen = new Set()
  const out = []
  let duplicates = 0
  for (const f of list) {
    if (seen.has(f.xmlUrl)) {
      duplicates++
      continue
    }
    seen.add(f.xmlUrl)
    out.push(f)
  }
  return { feeds: out, duplicates }
}

/** 由订阅列表构建 OPML 文本（按 '/' 分组路径嵌套）。 */
export function buildOpml(feeds, { title = 'dsh-rss 订阅' } = {}) {
  const root = { name: '', children: new Map(), feeds: [] }
  for (const f of feeds) {
    const parts = String(f.group || '').split('/').map((s) => s.trim()).filter(Boolean)
    let node = root
    for (const p of parts) {
      if (!node.children.has(p)) node.children.set(p, { name: p, children: new Map(), feeds: [] })
      node = node.children.get(p)
    }
    node.feeds.push(f)
  }
  const lines = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<opml version="1.0">')
  lines.push('  <head>')
  lines.push(`    <title>${escapeHtml(title)}</title>`)
  lines.push(`    <dateCreated>${escapeHtml(new Date().toISOString())}</dateCreated>`)
  lines.push('  </head>')
  lines.push('  <body>')
  const emit = (node, depth) => {
    const pad = '  '.repeat(depth + 2)
    for (const child of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))) {
      lines.push(`${pad}<outline text="${escapeHtml(child.name)}" title="${escapeHtml(child.name)}">`)
      emit(child, depth + 1)
      lines.push(`${pad}</outline>`)
    }
    for (const f of node.feeds) {
      const attrs = [
        'type="rss"',
        `text="${escapeHtml(f.title || f.xmlUrl)}"`,
        `title="${escapeHtml(f.title || f.xmlUrl)}"`,
        `xmlUrl="${escapeHtml(f.xmlUrl)}"`,
      ]
      if (f.siteUrl) attrs.push(`htmlUrl="${escapeHtml(f.siteUrl)}"`)
      lines.push(`${pad}<outline ${attrs.join(' ')} />`)
    }
  }
  emit(root, 0)
  lines.push('  </body>')
  lines.push('</opml>')
  return lines.join('\n')
}
