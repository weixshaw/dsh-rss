import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import * as host from '../index.js'
import { extractReadableHtml } from '../lib/fulltext.js'
import { stableEntryId } from '../lib/util.js'

// ---------- 抓取全文：正文提取器 + article/fetch-full 路由 ----------

const LONG = '这是一段足够长的正文内容。'.repeat(60) // ≈ 720 字

test('extractReadableHtml：优先 article 块；去 nav/header/footer/script；图片保留裸 img', () => {
  const page = `<html><head><title>站点</title><script>evil()</script><style>a{}</style></head>
  <body><header>站点头部</header><nav>菜单 甲 乙 丙</nav>
  <article><h1>标题</h1><p>${LONG}</p><img src="https://img.example/f.png" alt="插图"><p>第二段。</p></article>
  <aside>侧栏广告</aside><footer>页脚</footer></body></html>`
  const out = extractReadableHtml(page)
  assert.ok(out.includes('标题'))
  assert.ok(out.includes('足够长的正文内容'))
  assert.ok(out.includes('<img src="https://img.example/f.png" alt="插图">'), 'article 内图片应保留为裸 img')
  assert.ok(!/script|nav|header|footer|aside/i.test(out.replace(/<h1>/i, '')), '干扰元素应被整块移除（h1 的 header 子串除外）')
  assert.ok(!out.includes('菜单'), 'nav 内容不得残留')
  assert.ok(!out.includes('页脚'), 'footer 内容不得残留')
})

test('extractReadableHtml：无 article 时取 body；多个 article 取文字量最大者；过短内容判为未提取', () => {
  const bodyPage = `<html><body><header>头</header><main><p>${LONG}</p></main><footer>脚</footer></body></html>`
  const out = extractReadableHtml(bodyPage)
  assert.ok(out.includes('足够长的正文内容'))
  assert.ok(!out.includes('<header>') && !out.includes('页脚'))

  const multi = `<body><article><p>短的</p></article><article><p>${LONG}</p></article></body>`
  assert.ok(extractReadableHtml(multi).includes('足够长的正文内容'))

  const wall = '<html><body><div>请登录后查看</div></body></html>'
  assert.equal(extractReadableHtml(wall), '', '登录墙/低文字量应返回空串（按未提取处理）')
})

// ---------- 路由 ----------

const PAGE = `<html><head><title>原文页</title><script>alert(1)</script></head><body>
<header>站点导航</header><article><h1>全文标题</h1><p>${LONG}</p><img src="https://img.example/full.png" alt="全文插图"></article>
<footer>页脚</footer></body></html>`

async function startServer() {
  const server = createServer((req, res) => {
    if (req.url === '/page.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(PAGE)
    }
    if (req.url === '/empty.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end('<html><body><div>登录</div></body></html>')
    }
    res.writeHead(404)
    res.end('nf')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) }
}

let dir
let routes
const route = (name) => routes.find((r) => r.path === `/dsh-rss/${name}`)
const H = { 'x-dsh-rss': '1', 'content-type': 'application/json' }

function fakeReq(method, url, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:19999', ...H },
    async *[Symbol.asyncIterator]() {
      yield* payload
    },
  }
}

function invoke(r, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0, out: '',
      writeHead(code) { this.statusCode = code },
      end(b) { this.out = String(b || ''); resolve(this) },
    }
    Promise.resolve(r.handler(req, res)).catch(reject)
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-rss-full-'))
  routes = host.buildRouteTable(host.makeDeps(dir))
})

test('article/fetch-full：抓原文并返回提取正文；空提取/404 如实报错', async () => {
  const srv = await startServer()
  try {
    const deps = host.makeDeps(dir)
    routes = host.buildRouteTable(deps) // 路由与测试共用同一 Store 实例（同一内存态）
    const { store } = await deps.ready()
    const feed = await store.addFeed({ url: 'https://feed.example/x', title: 'X', kind: 'standalone' })
    const fullId = stableEntryId('https://feed.example/x', 'a1')
    const emptyId = stableEntryId('https://feed.example/x', 'a2')
    await store.putArticles(feed.id, [
      { externalId: 'a1', title: '摘要文', url: `${srv.origin}/page.html`, summaryHtml: '<p>只有摘要</p>', contentHtml: '<p>只有摘要</p>' },
      { externalId: 'a2', title: '登录墙文', url: `${srv.origin}/empty.html`, summaryHtml: '<p>摘要</p>', contentHtml: '<p>摘要</p>' },
    ], { feedKey: 'https://feed.example/x' })

    const okRes = await invoke(route('article/fetch-full'), fakeReq('POST', '/dsh-rss/article/fetch-full', { id: fullId }))
    assert.equal(okRes.statusCode, 200)
    const body = JSON.parse(okRes.out)
    assert.equal(body.ok, true)
    assert.ok(body.html.includes('全文标题'))
    assert.ok(body.html.includes('<img src="https://img.example/full.png" alt="全文插图">'))
    assert.ok(!body.html.includes('alert(1)'))
    assert.ok(!body.html.includes('站点导航'))
    assert.ok(body.chars > 200)

    const emptyRes = await invoke(route('article/fetch-full'), fakeReq('POST', '/dsh-rss/article/fetch-full', { id: emptyId }))
    assert.equal(emptyRes.statusCode, 400)
    assert.match(JSON.parse(emptyRes.out).error, /未能.*提取正文/)

    const goneId = stableEntryId('https://feed.example/x', 'a3')
    await store.putArticles(feed.id, [
      { externalId: 'a3', title: '404 文', url: `${srv.origin}/missing.html`, summaryHtml: '', contentHtml: '' },
    ], { feedKey: 'https://feed.example/x' })
    const goneRes = await invoke(route('article/fetch-full'), fakeReq('POST', '/dsh-rss/article/fetch-full', { id: goneId }))
    assert.equal(goneRes.statusCode, 400)
    assert.match(JSON.parse(goneRes.out).error, /HTTP 404/)

    const missing = await invoke(route('article/fetch-full'), fakeReq('POST', '/dsh-rss/article/fetch-full', { id: 'nope' }))
    assert.equal(missing.statusCode, 404)
  } finally {
    await srv.close()
  }
})
