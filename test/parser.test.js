import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFeed } from '../lib/feed-parser.js'
import { sanitizeStoredHtml, htmlToText } from '../lib/sanitize.js'
import { stableEntryId, normalizeFeedUrl, parseDateMs } from '../lib/util.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const rssXml = readFileSync(join(fixtures, 'rss-basic.xml'), 'utf8')
const atomXml = readFileSync(join(fixtures, 'atom-basic.xml'), 'utf8')

test('parseFeed: RSS 2.0 基本字段与实体/CDATA', () => {
  const feed = parseFeed(rssXml)
  assert.equal(feed.kind, 'rss')
  assert.equal(feed.title, '示例博客 & 周刊')
  assert.equal(feed.siteUrl, 'https://example.com/blog/')
  assert.equal(feed.items.length, 3)
  const it1 = feed.items[0]
  assert.equal(it1.title, '第一篇：实体 <测试> & CDATA')
  assert.equal(it1.url, 'https://example.com/blog/1')
  assert.equal(it1.externalId, 'post-1')
  assert.equal(it1.author, '张三')
  assert.equal(typeof it1.publishedMs, 'number')
  assert.ok(it1.publishedMs > 0)
  // content:encoded 的 <script> 被剥离、img 重建为只含校验过的 src/alt 的裸标签、onclick 被移除
  assert.ok(!it1.contentHtml.includes('<script'))
  assert.ok(!it1.contentHtml.includes('onclick'))
  assert.ok(it1.contentHtml.includes('<img src="https://img.example.com/a.png" alt="示意图">'))
  assert.ok(it1.contentHtml.includes('加粗'))
  // 纯文本（AI/搜索）仍回文本标记
  assert.ok(it1.contentText.includes('［图片：示意图］'))
  // 摘要来自 description
  assert.ok(it1.summaryHtml.includes('摘要内容'))
  // enclosure 记录但不自动抓取
  assert.equal(it1.enclosureUrl, 'https://example.com/audio/1.mp3')
})

test('parseFeed: RSS 无日期条目与危险协议链接', () => {
  const feed = parseFeed(rssXml)
  assert.equal(feed.items[1].publishedMs, null)
  const it3 = feed.items[2]
  assert.ok(!it3.summaryHtml.includes('javascript:'))
})

test('parseFeed: Atom 条目（rel=alternate 链接、published/updated、作者、清理）', () => {
  const feed = parseFeed(atomXml)
  assert.equal(feed.kind, 'atom')
  assert.equal(feed.title, 'Atom 示例源')
  assert.equal(feed.siteUrl, 'https://example.org/')
  const e1 = feed.items[0]
  assert.equal(e1.externalId, 'urn:uuid:aaa-1')
  assert.equal(e1.url, 'https://example.org/1')
  assert.equal(e1.author, '李四')
  assert.equal(e1.publishedMs, Date.parse('2026-10-04T10:00:00Z'))
  assert.equal(e1.updatedMs, Date.parse('2026-10-04T11:00:00Z'))
  assert.ok(!e1.contentHtml.includes('<iframe'))
  assert.ok(e1.contentHtml.includes('Atom 正文'))
  assert.equal(e1.enclosureUrl, 'https://example.org/1.mp3')
  const e2 = feed.items[1]
  assert.equal(e2.url, 'https://example.org/2')
})

test('parseFeed: 无法识别的内容抛错', () => {
  assert.throws(() => parseFeed('<html><body>not a feed</body></html>'), /无法识别/)
  assert.throws(() => parseFeed(''), /为空|无法识别/)
})

test('stableEntryId: 稳定且区分订阅', () => {
  const a = stableEntryId('https://a.example/feed', 'guid-1')
  const b = stableEntryId('https://a.example/feed', 'guid-1')
  const c = stableEntryId('https://b.example/feed', 'guid-1')
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('sanitizeStoredHtml: 脚本/事件/危险协议/图片处理', () => {
  const out = sanitizeStoredHtml('<p ok="1">hi</p><script>alert(1)</script><style>*{}</style><a href="jAvAsCrIpT:alert(1)">x</a><a href="https://ok.example">y</a><img src="http://img.example/x.png" alt="图"><iframe src="//e"></iframe><div onclick="go()">t</div>')
  assert.ok(!/<script/i.test(out))
  assert.ok(!/<style/i.test(out))
  assert.ok(!/<iframe/i.test(out))
  assert.ok(!/onclick/i.test(out))
  assert.ok(!/jAvAsCrIpT/i.test(out))
  // 合法 http 图片：保留为只含 src/alt 的裸标签（是否加载由渲染层决定）
  assert.ok(out.includes('<img src="http://img.example/x.png" alt="图">'))
  assert.ok(!/data-src/i.test(out), '重建后的 img 不得保留 data-src 等多余属性')
  assert.ok(out.includes('href="https://ok.example"'))
  // 非法/危险协议 src → 文本标记；data-src 懒加载回退
  const bad = sanitizeStoredHtml('<img src="javascript:alert(1)" alt="危险"><img src="data:image/png;base64,xxxx" alt="内联"><img src="about:blank"><img alt="无src">')
  assert.ok(!/javascript/i.test(bad))
  assert.ok(!/data:/i.test(bad))
  assert.ok(bad.includes('［图片：危险］'))
  assert.ok(bad.includes('［图片：内联］'))
  assert.ok(bad.includes('［图片：无src］'))
  const lazy = sanitizeStoredHtml('<img src="https://cdn.example/1px.gif" data-src="https://cdn.example/real.png" alt="真图">')
  assert.ok(lazy.includes('src="https://cdn.example/real.png"'), 'src 为占位图时应优先采用 data-src 真图地址（写进 src）')
  assert.ok(!/1px\.gif/.test(lazy), '占位图地址不得残留在输出里')
  // 属性值转义：alt 中的引号不得破坏标签结构
  const quoted = sanitizeStoredHtml('<img src="https://a.example/x.png" alt="a&quot;b">')
  assert.ok(!/alt="a"b"/.test(quoted), 'alt 引号必须被转义')
})

test('htmlToText: 去标签留段落与图片标记', () => {
  const t = htmlToText('<p>第一段</p><p>第二<b>段</b></p><br/><img src="x.png" alt="插图"/><script>no()</script>')
  assert.ok(t.includes('第一段'))
  assert.ok(t.includes('第二段'))
  assert.ok(t.includes('［图片：插图］'))
  assert.ok(!t.includes('script'))
})

test('normalizeFeedUrl: 协议白名单与规范化', () => {
  assert.equal(normalizeFeedUrl('HTTPS://Example.COM:443/feed/'), 'https://example.com/feed')
  assert.equal(normalizeFeedUrl('http://example.com:80/a#frag'), 'http://example.com/a')
  assert.throws(() => normalizeFeedUrl('ftp://example.com/x'), /http\/https/)
  assert.throws(() => normalizeFeedUrl('not a url'), /URL/)
})

test('parseDateMs: 常见格式', () => {
  assert.equal(parseDateMs('Mon, 05 Oct 2026 08:00:00 GMT'), Date.parse('2026-10-05T08:00:00Z'))
  assert.equal(parseDateMs('2026-10-04T10:00:00Z'), Date.parse('2026-10-04T10:00:00Z'))
  assert.equal(parseDateMs('1760000000'), 1760000000000)
  assert.equal(parseDateMs('垃圾'), null)
})
