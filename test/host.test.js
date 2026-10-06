import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import * as host from '../index.js'
import { Store } from '../lib/store.js'
import { loadConfig, saveConfig, sanitizeConfigPatch, applyConfigPatch } from '../lib/config.js'
import { stableEntryId } from '../lib/util.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const rssXml = readFileSync(join(fixtures, 'rss-basic.xml'), 'utf8')

// ---------- 本地回环夹具服务器（测试进程内启停，绑定 127.0.0.1:0） ----------

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function feedServer(state = {}) {
  return startServer((req, res) => {
    if (!state.requests) state.requests = []
    state.requests.push(req.url)
    if (req.url === '/feed.xml') {
      res.writeHead(200, { 'content-type': 'application/rss+xml' })
      return res.end(rssXml)
    }
    if (req.url === '/feed2.xml') {
      if (state.failFeed2) {
        res.writeHead(500)
        return res.end('boom')
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml' })
      return res.end(rssXml.replace(/example\.com/g, 'example2.com'))
    }
    if (req.url === '/atom.xml') {
      res.writeHead(200, { 'content-type': 'application/atom+xml' })
      return res.end(readFileSync(join(fixtures, 'atom-basic.xml'), 'utf8'))
    }
    res.writeHead(404)
    res.end('nf')
  })
}

/** 模拟 FreshRSS Google Reader API（按官方协议实现的最小端点集）。支持在条目流处暂停（测并发互斥）。 */
function greaderServer(state) {
  return startServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const path = url.pathname
    const readBody = async () => {
      const chunks = []
      for await (const c of req) chunks.push(c)
      return Buffer.concat(chunks).toString('utf8')
    }
    const base = '/api/greader.php'
    if (req.method === 'POST' && path === `${base}/accounts/ClientLogin`) {
      readBody().then((body) => {
        state.logins.push(body)
        if (body.includes('Passwd=apipw')) {
          res.writeHead(200)
          res.end('SID=sid\nAuth=AUTH-TOKEN\n')
        } else {
          res.writeHead(401)
          res.end('Unauthorized')
        }
      })
      return
    }
    const auth = req.headers.authorization || ''
    if (!auth.includes('GoogleLogin auth=AUTH-TOKEN')) {
      res.writeHead(401)
      return res.end('no auth')
    }
    if (path === `${base}/reader/api/0/subscription/list`) {
      res.writeHead(200)
      return res.end(JSON.stringify({ subscriptions: [
        { id: 'feed/1', title: '技术源', url: 'https://t.example/feed', htmlUrl: 'https://t.example', categories: [{ id: 'user/-/label/技术', label: '技术' }] },
        { id: 'feed/2', title: '普通源', url: 'https://n.example/feed', categories: [] },
      ] }))
    }
    if (path === `${base}/reader/api/0/stream/contents/user/-/state/com.google/reading-list`) {
      if (!state.streamQueries) state.streamQueries = []
      state.streamQueries.push({ ot: url.searchParams.get('ot'), c: url.searchParams.get('c') })
      if (state.streamSeen) state.streamSeen.resolve()
      if (state.pauseStream) await state.pauseStream
      const c = url.searchParams.get('c')
      if (!c) {
        res.writeHead(200)
        return res.end(JSON.stringify({
          items: [
            { id: 'item-1', title: '远端文章一（已读+星标）', published: 1760000100, canonical: [{ href: 'https://t.example/1' }], categories: ['user/-/state/com.google/read', 'user/-/state/com.google/starred'], origin: { streamId: 'feed/1' }, summary: { content: '<p>内容一</p>' } },
            { id: 'item-2', title: '远端文章二（未读）', published: 1760000200, canonical: [{ href: 'https://n.example/2' }], categories: [], origin: { streamId: 'feed/2' }, summary: { content: '<p>内容二</p>' } },
          ],
          continuation: '111',
        }))
      }
      if (c === '111') {
        res.writeHead(200)
        return res.end(JSON.stringify({
          items: [
            { id: 'item-3', title: '远端文章三', published: 1760000300, canonical: [{ href: 'https://t.example/3' }], categories: [], origin: { streamId: 'feed/1' }, summary: { content: '<p>内容三</p>' } },
          ],
        }))
      }
      res.writeHead(400)
      return res.end('bad continuation')
    }
    if (path === `${base}/reader/api/0/token`) {
      res.writeHead(200)
      return res.end('T'.repeat(57))
    }
    if (req.method === 'POST' && path === `${base}/reader/api/0/edit-tag`) {
      readBody().then((body) => {
        state.editTags.push(body)
        if (body.includes(`T=${'T'.repeat(57)}`)) {
          res.writeHead(200)
          res.end('OK')
        } else {
          res.writeHead(400)
          res.end('bad token')
        }
      })
      return
    }
    if (req.method === 'POST' && path === `${base}/reader/api/0/mark-all-as-read`) {
      readBody().then((body) => {
        state.markAll.push(body)
        res.writeHead(200)
        res.end('OK')
      })
      return
    }
    res.writeHead(404)
    res.end('greader nf')
  })
}

function openaiServer(state) {
  return startServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      state.calls.push({ url: url.pathname, auth: req.headers.authorization || '', body })
      if (url.pathname !== '/v1/chat/completions') {
        res.writeHead(404)
        return res.end('nf')
      }
      if (req.headers.authorization !== 'Bearer sk-test') {
        res.writeHead(401)
        return res.end('bad key')
      }
      res.writeHead(200)
      res.end(JSON.stringify({ choices: [{ message: { content: `这是AI输出：${JSON.parse(body).messages[1].content.slice(0, 3)}…` } }] }))
    })
  })
}

// ---------- 请求/响应仿真 ----------

function fakeReq(method, path, body, headers = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url: path,
    headers: { host: '127.0.0.1:19999', ...headers },
    async *[Symbol.asyncIterator]() {
      yield* payload
    },
  }
}

function invoke(route, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      out: '',
      writeHead(code, hdrs) { this.statusCode = code; this.headers = hdrs },
      end(b) {
        this.out = String(b || '')
        resolve(this)
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

const H = { 'x-dsh-rss': '1', 'content-type': 'application/json' }

// ---------- 套件 ----------

let dir
let deps
let routes
const route = (name) => routes.find((r) => r.path === `/dsh-rss/${name}`)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-rss-host-'))
  deps = host.makeDeps(dir)
  routes = host.buildRouteTable(deps)
})

test('路由表覆盖全部契约端点', () => {
  const paths = routes.map((r) => r.path)
  for (const p of ['config', 'feeds/list', 'feeds/add', 'feeds/update', 'feeds/remove', 'feeds/mark-all-read', 'refresh', 'articles', 'article', 'mark', 'opml/export', 'opml/import', 'freshrss/connect', 'freshrss/sync', 'ai/action', 'ping']) {
    assert.ok(paths.includes(`/dsh-rss/${p}`), `缺 ${p}`)
  }
  assert.ok(routes.every((r) => r.kind === 'exact' && r.name.startsWith('dsh-rss:') && typeof r.handler === 'function'))
})

test('同源防护：缺头 / 跨 Origin / 非 POST 分别拒绝', async () => {
  const ping = route('ping')
  const noHeader = await invoke(ping, fakeReq('POST', '/dsh-rss/ping', {}))
  assert.equal(noHeader.statusCode, 403)
  assert.match(JSON.parse(noHeader.out).error, /X-DSH-RSS/)
  const badOrigin = await invoke(ping, fakeReq('POST', '/dsh-rss/ping', {}, { ...H, origin: 'http://evil.example' }))
  assert.equal(badOrigin.statusCode, 403)
  assert.match(JSON.parse(badOrigin.out).error, /跨源/)
  const ok = await invoke(ping, fakeReq('POST', '/dsh-rss/ping', {}, H))
  assert.equal(ok.statusCode, 200)
  assert.equal(JSON.parse(ok.out).ok, true)
  const getOnly = await invoke(route('articles'), fakeReq('GET', '/dsh-rss/articles', undefined, H))
  assert.equal(getOnly.statusCode, 403) // articles 只允许 POST
})

test('config GET/POST：掩码、写-only 密钥、明文 HTTP 标记', async () => {
  const get1 = await invoke(route('config'), fakeReq('GET', '/dsh-rss/config', undefined, H))
  assert.equal(get1.statusCode, 200)
  assert.equal(JSON.parse(get1.out).config.freshrss.configured, false)
  const save = await invoke(route('config'), fakeReq('POST', '/dsh-rss/config', {
    config: { freshrss: { baseUrl: 'http://127.0.0.1:1', username: 'alice', apiPassword: 'apipw', enabled: true }, ai: { baseUrl: 'https://ai.test/v1', model: 'm', apiKey: 'sk-test', enabled: true } },
  }, H))
  assert.equal(save.statusCode, 200)
  const masked = JSON.parse(save.out).config
  assert.equal(masked.freshrss.hasApiPassword, true)
  assert.equal(masked.ai.hasApiKey, true)
  assert.equal(masked.freshrss.insecureHttp, true)
  assert.ok(!save.out.includes('apipw'))
  assert.ok(!save.out.includes('sk-test'))
  const cfg = await loadConfig(dir)
  assert.equal(cfg.freshrss.apiPassword, 'apipw') // 真实值只在 0600 文件里
})

test('feeds/add + articles + mark：完整本地阅读流程', async () => {
  const feeds = { requests: [] }
  const srv = await feedServer(feeds)
  try {
    const add = await invoke(route('feeds/add'), fakeReq('POST', '/dsh-rss/feeds/add', { url: `${srv.origin}/feed.xml`, group: '测试' }, H))
    assert.equal(add.statusCode, 200)
    const body = JSON.parse(add.out)
    assert.equal(body.ok, true)
    assert.equal(body.counts.added, 3)
    assert.equal(body.insecure, true) // 127.0.0.1 是 http → 明文标记
    const feedId = body.feed.id
    const list = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { filter: 'all' }, H))
    const page = JSON.parse(list.out)
    assert.equal(page.total, 3)
    const first = page.items.find((a) => a.title.includes('第一篇'))
    assert.equal(first.feedTitle, '示例博客 & 周刊')
    assert.equal(first.group, '测试')
    // 标记已读 + 收藏
    const mark = await invoke(route('mark'), fakeReq('POST', '/dsh-rss/mark', { id: first.id, read: true, starred: true }, H))
    assert.equal(JSON.parse(mark.out).ok, true)
    const unread = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { filter: 'unread' }, H))
    assert.equal(JSON.parse(unread.out).total, 2)
    const starred = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { filter: 'starred' }, H))
    assert.equal(JSON.parse(starred.out).total, 1)
    // 搜索
    const search = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { search: '第二篇' }, H))
    assert.equal(JSON.parse(search.out).total, 1)
    // 单篇
    const one = await invoke(route('article'), fakeReq('POST', '/dsh-rss/article', { id: first.id }, H))
    const art = JSON.parse(one.out).article
    assert.ok(art.contentHtml.includes('加粗'))
    assert.equal(art.read, true)
  } finally {
    await srv.close()
  }
})

test('refresh：部分失败如实上报，成功订阅仍更新', async () => {
  const state = { failFeed2: false }
  const srv = await feedServer(state)
  try {
    await invoke(route('feeds/add'), fakeReq('POST', '/dsh-rss/feeds/add', { url: `${srv.origin}/feed.xml` }, H))
    await invoke(route('feeds/add'), fakeReq('POST', '/dsh-rss/feeds/add', { url: `${srv.origin}/feed2.xml` }, H))
    state.failFeed2 = true // 加入后服务端开始 500
    const r = await invoke(route('refresh'), fakeReq('POST', '/dsh-rss/refresh', {}, H))
    const body = JSON.parse(r.out)
    // 部分失败：整体 ok=true（至少一个成功），但逐条结果如实带上失败原因
    assert.equal(body.ok, true)
    assert.equal(body.results.length, 2)
    const okRes2 = body.results.find((x) => x.ok)
    const badRes = body.results.find((x) => !x.ok)
    assert.equal(okRes2.added + okRes2.updated + okRes2.kept, 3)
    assert.match(badRes.error, /HTTP 500|500/)
    const feeds = await new Store(dir).init().then((s) => s.listFeeds())
    assert.ok(feeds.find((f) => f.url.endsWith('/feed.xml')).lastError === null)
    assert.match(feeds.find((f) => f.url.endsWith('/feed2.xml')).lastError, /500/)
  } finally {
    await srv.close()
  }
})

test('refresh：ETag 条件请求——首次缓存验证器，304 跳过解析且缓存保留', async () => {
  const hits = []
  const srv = await startServer((req, res) => {
    hits.push({ url: req.url, inm: req.headers['if-none-match'] || null })
    if (req.url === '/etag.xml') {
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304)
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml', etag: '"v1"' })
      return res.end(rssXml)
    }
    res.writeHead(404)
    res.end('nf')
  })
  try {
    const add = await invoke(route('feeds/add'), fakeReq('POST', '/dsh-rss/feeds/add', { url: `${srv.origin}/etag.xml` }, H))
    const feed0 = JSON.parse(add.out).feed
    assert.equal(feed0.etag, '"v1"', '首次抓取即应缓存 ETag')
    const r1 = await invoke(route('refresh'), fakeReq('POST', '/dsh-rss/refresh', {}, H))
    const b1 = JSON.parse(r1.out)
    assert.equal(b1.ok, true)
    assert.equal(b1.results[0].notModified, true, '服务端 304 → notModified')
    assert.equal(b1.results[0].added + b1.results[0].updated + b1.results[0].kept, 0)
    assert.equal(hits.at(-1).inm, '"v1"', '刷新应带 If-None-Match 条件头')
    const feeds = await new Store(dir).init().then((s) => s.listFeeds())
    assert.equal(feeds.find((f) => f.id === feed0.id).etag, '"v1"', '304 不清除已缓存验证器')
    const articles = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { feedId: feed0.id }, H))
    assert.equal(JSON.parse(articles.out).total, 3, '304 后本地缓存原样保留')
  } finally {
    await srv.close()
  }
})

test('refresh：多订阅有界并发（不再串行等待）', async () => {
  const DELAY = 350
  const srv = await startServer((req, res) => {
    if (/^\/slow\d+\.xml$/.test(req.url)) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/rss+xml' })
        res.end(rssXml.replace(/example\.com/g, `slow${req.url.slice(5, -4)}.example`))
      }, DELAY)
      return
    }
    res.writeHead(404)
    res.end('nf')
  })
  try {
    for (let i = 0; i < 3; i++) {
      await invoke(route('feeds/add'), fakeReq('POST', '/dsh-rss/feeds/add', { url: `${srv.origin}/slow${i}.xml` }, H))
    }
    const t0 = Date.now()
    const r = await invoke(route('refresh'), fakeReq('POST', '/dsh-rss/refresh', {}, H))
    const elapsed = Date.now() - t0
    const body = JSON.parse(r.out)
    assert.equal(body.results.length, 3)
    assert.ok(body.results.every((x) => x.ok), '并发下每个订阅都应成功')
    assert.ok(elapsed < DELAY * 2, `3 个订阅应并发完成（实测 ${elapsed}ms；串行需 ≥${DELAY * 3}ms）`)
  } finally {
    await srv.close()
  }
})

test('OPML 导入：预览（不写入）→ 确认导入 → 重复导入预览', async () => {
  const xml = readFileSync(join(fixtures, 'opml-nested.xml'), 'utf8')
  // 预览：不写入
  const prev = await invoke(route('opml/import'), fakeReq('POST', '/dsh-rss/opml/import', { xml }, H))
  const pv = JSON.parse(prev.out)
  assert.equal(pv.ok, true)
  assert.equal(pv.preview, true)
  assert.equal(pv.total, 4)
  assert.equal(pv.toImport, 3)
  assert.equal(pv.duplicatesInFile, 1)
  assert.equal(pv.skipped, 1)
  const { store: pvStore } = await deps.ready()
  assert.equal((await pvStore.stats()).feeds, 0, '预览不应写入订阅')
  // 确认导入
  const imp = await invoke(route('opml/import'), fakeReq('POST', '/dsh-rss/opml/import', { xml, confirm: true }, H))
  const body = JSON.parse(imp.out)
  assert.equal(body.ok, true)
  assert.equal(body.preview, false)
  assert.equal(body.imported, 3)
  const exp = await invoke(route('opml/export'), fakeReq('POST', '/dsh-rss/opml/export', {}, H))
  const out = JSON.parse(exp.out)
  assert.equal(out.count, 3)
  assert.ok(out.opml.includes('xmlUrl="https://www.zhangxinxu.com/wordpress/feed"'))
  // 再次预览 → 全部已存在
  const prev2 = await invoke(route('opml/import'), fakeReq('POST', '/dsh-rss/opml/import', { xml }, H))
  assert.equal(JSON.parse(prev2.out).alreadyExisting, 3)
  assert.equal(JSON.parse(prev2.out).toImport, 0)
})

test('FreshRSS：connect + 全量同步 + 读/星标写回（mock 服务端按官方协议）', async () => {
  const state = { logins: [], editTags: [], markAll: [] }
  const srv = await greaderServer(state)
  try {
    await invoke(route('config'), fakeReq('POST', '/dsh-rss/config', { config: { freshrss: { baseUrl: srv.origin, username: 'alice', apiPassword: 'apipw', enabled: true } } }, H))
    // 连接测试
    const conn = await invoke(route('freshrss/connect'), fakeReq('POST', '/dsh-rss/freshrss/connect', {}, H))
    const connBody = JSON.parse(conn.out)
    assert.equal(connBody.ok, true)
    assert.equal(connBody.feeds, 2)
    assert.ok(connBody.groups.includes('技术'))
    assert.equal(connBody.insecure, true) // http://127.0.0.1
    // 第一次同步：拉取 2 订阅 + 3 篇（含分页），远端已读/星标落地
    const sync1 = await invoke(route('freshrss/sync'), fakeReq('POST', '/dsh-rss/freshrss/sync', {}, H))
    const s1 = JSON.parse(sync1.out)
    assert.equal(s1.ok, true)
    assert.equal(s1.feeds, 2)
    assert.equal(s1.items, 3)
    assert.equal(s1.remoteMarks, 2) // item-1 的 read + starred
    assert.equal(s1.incremental, false, '首次同步为全量')
    assert.equal(state.streamQueries[0].ot, null, '首次同步不应带 ot')
    const list = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { filter: 'starred' }, H))
    const starred = JSON.parse(list.out)
    assert.equal(starred.total, 1)
    assert.equal(starred.items[0].title, '远端文章一（已读+星标）')
    assert.equal(starred.items[0].feedKind, 'greader')
    assert.equal(starred.items[0].group, '技术')
    // 本地标记 item-2 已读+收藏 → 队列 → 第二次同步写回服务端
    const page = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { filter: 'unread' }, H))
    const item2 = JSON.parse(page.out).items.find((a) => a.title === '远端文章二（未读）')
    assert.ok(item2, '应能找到未读的远端文章二')
    await invoke(route('mark'), fakeReq('POST', '/dsh-rss/mark', { id: item2.id, read: true, starred: true }, H))
    const sync2 = await invoke(route('freshrss/sync'), fakeReq('POST', '/dsh-rss/freshrss/sync', {}, H))
    const s2 = JSON.parse(sync2.out)
    assert.equal(s2.ok, true)
    assert.equal(s2.pushed.read, 1)
    assert.equal(s2.pushed.star, 1)
    assert.equal(s2.incremental, true, '有游标后的同步为增量')
    const ot2 = Number(state.streamQueries.at(-1).ot)
    assert.ok(Number.isFinite(ot2) && ot2 > 0, `第二次同步应下发 ot（实测 ${state.streamQueries.at(-1).ot}）`)
    const editBodies = state.editTags.filter((b) => b.includes('i=item-2'))
    assert.ok(editBodies.length >= 2, 'read 与 star 各一次 edit-tag')
    assert.ok(editBodies.some((b) => b.includes('a=user%2F-%2Fstate%2Fcom.google%2Fread')))
    assert.ok(editBodies.some((b) => b.includes('a=user%2F-%2Fstate%2Fcom.google%2Fstarred')))
    assert.ok(editBodies.every((b) => b.includes(`T=${'T'.repeat(57)}`)))
    // 推送成功后队列清空
    const stats = JSON.parse((await invoke(route('config'), fakeReq('GET', '/dsh-rss/config', undefined, H))).out).stats
    assert.equal(stats.pendingFresh.total, 0)
  } finally {
    await srv.close()
  }
})

test('FreshRSS 账号隔离：变更账号 → 失败关闭 → 确认重置 → 新账号不串写', async () => {
  const stateA = { logins: [], editTags: [], markAll: [] }
  const stateB = { logins: [], editTags: [], markAll: [] }
  const srvA = await greaderServer(stateA)
  const srvB = await greaderServer(stateB)
  try {
    // 账号 A：配置 → 同步 → 本地标记产生待推送
    await invoke(route('config'), fakeReq('POST', '/dsh-rss/config', { config: { freshrss: { baseUrl: srvA.origin, username: 'alice', apiPassword: 'apipw', enabled: true } } }, H))
    const s1 = JSON.parse((await invoke(route('freshrss/sync'), fakeReq('POST', '/dsh-rss/freshrss/sync', {}, H))).out)
    assert.equal(s1.ok, true)
    const page = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { filter: 'unread' }, H))
    const item2 = JSON.parse(page.out).items.find((a) => a.title === '远端文章二（未读）')
    await invoke(route('mark'), fakeReq('POST', '/dsh-rss/mark', { id: item2.id, read: true }, H))
    let stats = JSON.parse((await invoke(route('config'), fakeReq('GET', '/dsh-rss/config', undefined, H))).out).stats
    assert.equal(stats.pendingFresh.total, 1, 'A 账号下应有一条待推送已读')

    // 换账号 B（不带密码）：needsReset 置位 + 旧密码清空
    const saved = await invoke(route('config'), fakeReq('POST', '/dsh-rss/config', { config: { freshrss: { baseUrl: srvB.origin, username: 'bob' } } }, H))
    const masked = JSON.parse(saved.out).config.freshrss
    assert.equal(masked.needsReset, true)
    assert.equal(masked.hasApiPassword, false)

    // 失败关闭：connect / sync 都拒绝，B 服务器未收到任何请求
    const conn = await invoke(route('freshrss/connect'), fakeReq('POST', '/dsh-rss/freshrss/connect', {}, H))
    assert.equal(conn.statusCode, 400)
    assert.match(JSON.parse(conn.out).error, /账号未确认/)
    const syncBlocked = await invoke(route('freshrss/sync'), fakeReq('POST', '/dsh-rss/freshrss/sync', {}, H))
    assert.equal(syncBlocked.statusCode, 400)
    assert.match(JSON.parse(syncBlocked.out).error, /账号未确认/)
    assert.equal(stateB.logins.length, 0)
    assert.equal(stateB.editTags.length, 0)

    // 确认重置：greader 数据与待推送清空，needsReset 解除
    const reset = await invoke(route('freshrss/reset'), fakeReq('POST', '/dsh-rss/freshrss/reset', {}, H))
    const rb = JSON.parse(reset.out)
    assert.equal(rb.ok, true)
    assert.equal(rb.feeds, 2)
    assert.equal(rb.pending.total, 0)
    stats = JSON.parse((await invoke(route('config'), fakeReq('GET', '/dsh-rss/config', undefined, H))).out).stats
    assert.equal(stats.greader, 0)
    assert.equal(stats.pendingFresh.total, 0, '重置必须清掉 A 的待推送队列')

    // 配置 B 密码（同账号补丁不触发再次 reset）→ 同步 B：A 的 pending 不会写到 B
    const saved2 = await invoke(route('config'), fakeReq('POST', '/dsh-rss/config', { config: { freshrss: { baseUrl: srvB.origin, username: 'bob', apiPassword: 'apipw', enabled: true } } }, H))
    assert.equal(JSON.parse(saved2.out).config.freshrss.needsReset, false)
    const s2 = JSON.parse((await invoke(route('freshrss/sync'), fakeReq('POST', '/dsh-rss/freshrss/sync', {}, H))).out)
    assert.equal(s2.ok, true)
    assert.equal(stateB.editTags.length, 0, 'B 服务器不应收到 A 账号的待推送标记')

    // B 账号下的新本地标记 → 写到 B
    const pageB = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { filter: 'unread' }, H))
    const itemB = JSON.parse(pageB.out).items.find((a) => a.title === '远端文章二（未读）')
    await invoke(route('mark'), fakeReq('POST', '/dsh-rss/mark', { id: itemB.id, read: true }, H))
    const s3 = JSON.parse((await invoke(route('freshrss/sync'), fakeReq('POST', '/dsh-rss/freshrss/sync', {}, H))).out)
    assert.equal(s3.pushed.read, 1)
    assert.ok(stateB.editTags.some((b) => b.includes('i=item-2')), 'B 账号的标记应写到 B')
    assert.equal(stateA.editTags.filter((b) => b.includes('i=item-2')).length, 0, 'A 服务器不应收到 B 的标记')
  } finally {
    await srvA.close()
    await srvB.close()
  }
})

test('FreshRSS 同步互斥：并发请求串行执行且失败不卡链', async () => {
  const deps2 = host.makeDeps(join(dir, 'mutex'))
  const order = []
  const p1 = deps2.runAccountOp(async () => { await new Promise((r) => setTimeout(r, 20)); order.push('a') })
  const p2 = deps2.runAccountOp(async () => { order.push('b') })
  await Promise.all([p1, p2])
  assert.deepEqual(order, ['a', 'b'], '后提交的账号操作必须等前一个完成')
  const p3 = deps2.runAccountOp(async () => { throw new Error('boom') }).catch(() => 'failed')
  const p4 = deps2.runAccountOp(async () => 'ok')
  assert.equal(await p3, 'failed')
  assert.equal(await p4, 'ok', '前一次失败不应卡死队列')
})

const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

test('账号互斥：在途同步期间切换账号/重置被排队，A 数据与标记不会落入 B', async () => {
  const stateA = { logins: [], editTags: [], markAll: [] }
  const stateB = { logins: [], editTags: [], markAll: [] }
  const srvA = await greaderServer(stateA)
  const srvB = await greaderServer(stateB)
  try {
    // 账号 A：配置 + 完整同步 + 产生待推送
    await invoke(route('config'), fakeReq('POST', '/dsh-rss/config', { config: { freshrss: { baseUrl: srvA.origin, username: 'alice', apiPassword: 'apipw', enabled: true } } }, H))
    await invoke(route('freshrss/sync'), fakeReq('POST', '/dsh-rss/freshrss/sync', {}, H))
    const pageA = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { filter: 'unread' }, H))
    const item2 = JSON.parse(pageA.out).items.find((a) => a.title === '远端文章二（未读）')
    await invoke(route('mark'), fakeReq('POST', '/dsh-rss/mark', { id: item2.id, read: true }, H))

    // 门：A 服务端在条目流处暂停，同步在途
    const gate = deferred()
    const streamSeen = deferred()
    stateA.pauseStream = gate.promise
    stateA.streamSeen = streamSeen
    const syncP = invoke(route('freshrss/sync'), fakeReq('POST', '/dsh-rss/freshrss/sync', {}, H))
    await streamSeen.promise

    // 与此同时请求：切到账号 B（不带密码）+ 重置 —— 必须排在同步之后
    const cfgP = invoke(route('config'), fakeReq('POST', '/dsh-rss/config', { config: { freshrss: { baseUrl: srvB.origin, username: 'bob' } } }, H))
    const resetP = invoke(route('freshrss/reset'), fakeReq('POST', '/dsh-rss/freshrss/reset', {}, H))
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(stateB.logins.length, 0, '同步在途时 B 不应收到任何请求')
    assert.equal(JSON.parse((await invoke(route('config'), fakeReq('GET', '/dsh-rss/config', undefined, H))).out).stats.greader, 2, '同步未完成前 A 数据仍在')

    // 放行：A 同步完成（待推送给 A），然后配置切换与重置依次执行
    gate.resolve()
    const syncOut = JSON.parse((await syncP).out)
    assert.equal(syncOut.ok, true)
    assert.ok(stateA.editTags.some((b) => b.includes('i=item-2')), 'A 的待推送应写到 A')
    const cfgOut = JSON.parse((await cfgP).out)
    assert.equal(cfgOut.config.freshrss.needsReset, true)
    const resetOut = JSON.parse((await resetP).out)
    assert.equal(resetOut.ok, true)
    let stats = JSON.parse((await invoke(route('config'), fakeReq('GET', '/dsh-rss/config', undefined, H))).out).stats
    assert.equal(stats.greader, 0, '重置应清掉 A 的订阅')
    assert.equal(stats.pendingFresh.total, 0, '重置应清掉 A 的待推送')
    assert.equal(stateB.logins.length, 0, '重置前 B 仍未收到任何请求')

    // 配置 B 密码 → 同步 B：不含任何 A 的标记
    await invoke(route('config'), fakeReq('POST', '/dsh-rss/config', { config: { freshrss: { baseUrl: srvB.origin, username: 'bob', apiPassword: 'apipw', enabled: true } } }, H))
    const sB = JSON.parse((await invoke(route('freshrss/sync'), fakeReq('POST', '/dsh-rss/freshrss/sync', {}, H))).out)
    assert.equal(sB.ok, true)
    assert.equal(stateB.editTags.length, 0, 'B 不应收到 A 的任何标记')

    // B 账号下的新本地标记 → 写到 B
    const pageB = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { filter: 'unread' }, H))
    const itemB = JSON.parse(pageB.out).items.find((a) => a.title === '远端文章二（未读）')
    await invoke(route('mark'), fakeReq('POST', '/dsh-rss/mark', { id: itemB.id, read: true }, H))
    const sB2 = JSON.parse((await invoke(route('freshrss/sync'), fakeReq('POST', '/dsh-rss/freshrss/sync', {}, H))).out)
    assert.equal(sB2.pushed.read, 1)
    assert.ok(stateB.editTags.some((b) => b.includes('i=item-2')))
    assert.equal(stateA.editTags.filter((b) => b.includes('i=item-2')).length, 1, 'A 只收到自己那一次（B 的没发给 A）')
    void stats
  } finally {
    await srvA.close()
    await srvB.close()
  }
})

test('账号守卫：把 freshrss 置 null 也无法绕过（greader 数据存在即失败关闭）', async () => {
  const stateA = { logins: [], editTags: [], markAll: [] }
  const stateB = { logins: [], editTags: [], markAll: [] }
  const srvA = await greaderServer(stateA)
  const srvB = await greaderServer(stateB)
  try {
    // 账号 A：配置 + 同步 + 待推送
    await invoke(route('config'), fakeReq('POST', '/dsh-rss/config', { config: { freshrss: { baseUrl: srvA.origin, username: 'alice', apiPassword: 'apipw', enabled: true } } }, H))
    await invoke(route('freshrss/sync'), fakeReq('POST', '/dsh-rss/freshrss/sync', {}, H))
    const pageA = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { filter: 'unread' }, H))
    const item2 = JSON.parse(pageA.out).items.find((a) => a.title === '远端文章二（未读）')
    await invoke(route('mark'), fakeReq('POST', '/dsh-rss/mark', { id: item2.id, read: true }, H))

    // 绕过尝试一：freshrss 整体置 null
    const nulled = await invoke(route('config'), fakeReq('POST', '/dsh-rss/config', { config: { freshrss: null } }, H))
    assert.equal(JSON.parse(nulled.out).ok, true)
    // 绕过尝试二：直接配置账号 B（此时配置里已没有旧 accountKey 可比较）
    const cfgB = await invoke(route('config'), fakeReq('POST', '/dsh-rss/config', { config: { freshrss: { baseUrl: srvB.origin, username: 'bob', apiPassword: 'apipw', enabled: true } } }, H))
    assert.equal(JSON.parse(cfgB.out).ok, true)
    // connect / sync 仍失败关闭；B 零请求
    const conn = await invoke(route('freshrss/connect'), fakeReq('POST', '/dsh-rss/freshrss/connect', {}, H))
    assert.equal(conn.statusCode, 400)
    assert.match(JSON.parse(conn.out).error, /账号未确认/)
    const syncBlocked = await invoke(route('freshrss/sync'), fakeReq('POST', '/dsh-rss/freshrss/sync', {}, H))
    assert.equal(syncBlocked.statusCode, 400)
    assert.match(JSON.parse(syncBlocked.out).error, /账号未确认/)
    assert.equal(stateB.logins.length, 0)
    assert.equal(stateB.editTags.length, 0)
    // 确认重置后 B 可用，且 A 的待推送没有串写
    const reset = await invoke(route('freshrss/reset'), fakeReq('POST', '/dsh-rss/freshrss/reset', {}, H))
    assert.equal(JSON.parse(reset.out).ok, true)
    const sB = JSON.parse((await invoke(route('freshrss/sync'), fakeReq('POST', '/dsh-rss/freshrss/sync', {}, H))).out)
    assert.equal(sB.ok, true)
    assert.equal(stateB.editTags.length, 0, 'A 的待推送不得写到 B')
  } finally {
    await srvA.close()
    await srvB.close()
  }
})

test('FreshRSS：密码错误时如实报错（不假装成功）', async () => {
  const state = { logins: [], editTags: [], markAll: [] }
  const srv = await greaderServer(state)
  try {
    await invoke(route('config'), fakeReq('POST', '/dsh-rss/config', { config: { freshrss: { baseUrl: srv.origin, username: 'bob', apiPassword: 'wrong', enabled: true } } }, H))
    const conn = await invoke(route('freshrss/connect'), fakeReq('POST', '/dsh-rss/freshrss/connect', {}, H))
    assert.equal(conn.statusCode, 400)
    assert.match(JSON.parse(conn.out).error, /认证失败/)
    assert.ok(!conn.out.includes('wrong'))
  } finally {
    await srv.close()
  }
})

test('AI：summary/ask 真实调用 BYOK 接口并持久化；响应不含 Key', async () => {
  const aiState = { calls: [] }
  const srv = await openaiServer(aiState)
  const feedSrv = await feedServer({})
  try {
    await invoke(route('config'), fakeReq('POST', '/dsh-rss/config', { config: { ai: { baseUrl: srv.origin, model: 'test-model', apiKey: 'sk-test', enabled: true } } }, H))
    const add = await invoke(route('feeds/add'), fakeReq('POST', '/dsh-rss/feeds/add', { url: `${feedSrv.origin}/feed.xml` }, H))
    const feedId = JSON.parse(add.out).feed.id
    const page = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', {}, H))
    const artId = JSON.parse(page.out).items[0].id
    const r1 = await invoke(route('ai/action'), fakeReq('POST', '/dsh-rss/ai/action', { articleId: artId, action: 'summary' }, H))
    const b1 = JSON.parse(r1.out)
    assert.equal(b1.ok, true)
    assert.equal(b1.model, 'test-model')
    assert.ok(b1.text.length > 0)
    assert.ok(!r1.out.includes('sk-test'))
    assert.equal(aiState.calls.length, 1)
    assert.equal(aiState.calls[0].url, '/v1/chat/completions')
    const sent = JSON.parse(aiState.calls[0].body)
    assert.match(sent.messages[0].content, /不可信/)
    // 提问
    const r2 = await invoke(route('ai/action'), fakeReq('POST', '/dsh-rss/ai/action', { articleId: artId, action: 'ask', question: '这篇讲了什么？' }, H))
    assert.equal(JSON.parse(r2.out).ok, true)
    assert.equal(aiState.calls.length, 2)
    assert.match(JSON.parse(aiState.calls[1].body).messages[1].content, /这篇讲了什么/)
    // 结果已持久化
    const one = await invoke(route('article'), fakeReq('POST', '/dsh-rss/article', { id: artId }, H))
    const results = JSON.parse(one.out).article.aiResults
    assert.equal(results.length, 2)
    assert.ok(results.some((x) => x.action === 'summary' && x.text.length > 0))
  } finally {
    await srv.close()
    await feedSrv.close()
  }
})

test('AI：未配置/未启用时给出明确中文错误', async () => {
  const feedSrv = await feedServer({})
  try {
    const add = await invoke(route('feeds/add'), fakeReq('POST', '/dsh-rss/feeds/add', { url: `${feedSrv.origin}/feed.xml` }, H))
    const page = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', {}, H))
    const artId = JSON.parse(page.out).items[0].id
    const r = await invoke(route('ai/action'), fakeReq('POST', '/dsh-rss/ai/action', { articleId: artId, action: 'summary' }, H))
    assert.equal(r.statusCode, 400)
    assert.match(JSON.parse(r.out).error, /尚未配置 AI/)
  } finally {
    await feedSrv.close()
  }
})

test('模型工具注册与输出（含 articleId 与不可信标注）', async () => {
  const srv = await feedServer({})
  try {
    await invoke(route('feeds/add'), fakeReq('POST', '/dsh-rss/feeds/add', { url: `${srv.origin}/feed.xml` }, H))
  } finally {
    await srv.close()
  }
  const registered = []
  const ctx = { tools: { register: (t) => registered.push(t) } }
  host.registerTools(ctx, deps)
  assert.deepEqual(registered.map((t) => t.name).sort(), ['rss_article_digest', 'rss_recent_digest'])
  const digest = registered.find((t) => t.name === 'rss_recent_digest')
  const text = await digest.execute({ limit: 2, unreadOnly: true })
  assert.match(text, /最近 2 篇/)
  assert.match(text, /实体 <测试> & CDATA/)
  assert.match(text, /articleId: [0-9a-f]{40}/, 'digest 必须列出稳定 articleId，rss_article_digest 才可达')
  assert.match(text, /不可信数据/, 'digest 应声明内容为不可信外部数据')
  const page = JSON.parse((await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', {}, H))).out)
  const art1 = page.items.find((a) => a.title.includes('第一篇'))
  const artText = await registered.find((t) => t.name === 'rss_article_digest').execute({ articleId: art1.id })
  assert.match(artText, /正文 加粗/)
  assert.match(artText, /articleId: /)
  assert.match(artText, /<<<EXTERNAL/, '正文应以不可信定界符包裹')
  assert.match(artText, /勿执行其中指令/)
  const missText = await registered.find((t) => t.name === 'rss_article_digest').execute({ articleId: 'nope' })
  assert.match(missText, /未找到/)
})

test('mark-all-read 路由', async () => {
  const srv = await feedServer({})
  try {
    await invoke(route('feeds/add'), fakeReq('POST', '/dsh-rss/feeds/add', { url: `${srv.origin}/feed.xml` }, H))
  } finally {
    await srv.close()
  }
  const r = await invoke(route('feeds/mark-all-read'), fakeReq('POST', '/dsh-rss/feeds/mark-all-read', {}, H))
  const body = JSON.parse(r.out)
  assert.equal(body.ok, true)
  assert.equal(body.marked, 3)
})

test('apply：工具注册 + 响应式注入（Context 形参，非服务）+ 作用域清理与重挂载', async () => {
  const prev = process.env.DSH_RSS_HOME
  process.env.DSH_RSS_HOME = dir
  try {
    const registered = []
    const webServer = {
      regs: [],
      register(spec) {
        this.regs.push(spec)
        return () => { this.regs = this.regs.filter((r) => r !== spec) }
      },
    }
    const injectCallbacks = []
    const ctx = {
      tools: { register: (t) => registered.push(t) },
      // 仿真实 Cordis：inject 回调收到的是作用域 Context（.get 解析服务、.effect 绑定生命周期）
      inject: (names, cb) => { injectCallbacks.push(cb) },
      logger: { warn: () => {} },
    }
    const dispose = host.apply(ctx)
    assert.equal(registered.length, 2)
    assert.equal(injectCallbacks.length, 1)

    const scopeDisposers = []
    const makeScope = () => ({
      get: (n) => (n === 'webServer' ? webServer : undefined),
      effect: (fn) => {
        const d = fn()
        scopeDisposers.push(d)
        return d
      },
    })
    // 服务就绪 → 作用域回调 → 通过 effect 注册路由
    injectCallbacks[0](makeScope())
    assert.equal(webServer.regs.length, routes.length, '应注册全部路由')
    assert.equal(scopeDisposers.length, 1)
    // 服务下线 → 作用域销毁 → 路由自动清理
    scopeDisposers.splice(0).forEach((d) => d())
    assert.equal(webServer.regs.length, 0)
    // 服务恢复 → 回调重跑 → 重新注册（不重复、不泄漏）
    injectCallbacks[0](makeScope())
    assert.equal(webServer.regs.length, routes.length)
    // 插件卸载 → 清理全部
    dispose()
    assert.equal(webServer.regs.length, 0)

    // 无 effect 的作用域：直接注册，由插件级 dispose 兜底（dispose 可重复调用）
    injectCallbacks[0]({ get: (n) => (n === 'webServer' ? webServer : undefined) })
    assert.equal(webServer.regs.length, routes.length)
    dispose()
    assert.equal(webServer.regs.length, 0, '插件级 dispose 应兜底清理')
  } finally {
    if (prev === undefined) delete process.env.DSH_RSS_HOME
    else process.env.DSH_RSS_HOME = prev
  }
})

// ---------- 分组浏览契约：feeds/list 计数、articles groups/offset、mark-all-read 作用域 ----------

test('feeds/list：返回每订阅真实计数 counts', async () => {
  const srv = await feedServer({})
  try {
    const a = await invoke(route('feeds/add'), fakeReq('POST', '/dsh-rss/feeds/add', { url: `${srv.origin}/feed.xml`, group: '技术/甲' }, H))
    const b = await invoke(route('feeds/add'), fakeReq('POST', '/dsh-rss/feeds/add', { url: `${srv.origin}/feed2.xml` }, H))
    const idA = JSON.parse(a.out).feed.id
    const idB = JSON.parse(b.out).feed.id
    const list = await invoke(route('feeds/list'), fakeReq('POST', '/dsh-rss/feeds/list', {}, H))
    const body = JSON.parse(list.out)
    assert.equal(body.ok, true)
    assert.deepEqual(body.counts[idA], { total: 3, unread: 3, starred: 0 })
    assert.deepEqual(body.counts[idB], { total: 3, unread: 3, starred: 0 })
    assert.ok(body.stats && typeof body.stats.unread === 'number')
  } finally {
    await srv.close()
  }
})

test('articles：groups 集合（子树/未分组空串桶）+ offset 分页透传', async () => {
  const srv = await feedServer({})
  try {
    await invoke(route('feeds/add'), fakeReq('POST', '/dsh-rss/feeds/add', { url: `${srv.origin}/feed.xml`, group: '技术/甲' }, H))
    await invoke(route('feeds/add'), fakeReq('POST', '/dsh-rss/feeds/add', { url: `${srv.origin}/feed2.xml` }, H))
    const subtree = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { groups: ['技术/甲'] }, H))
    const sub = JSON.parse(subtree.out)
    assert.equal(sub.ok, true)
    assert.equal(sub.total, 3)
    assert.ok(sub.items.every((x) => x.group === '技术/甲'))
    const ungrouped = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { groups: [''] }, H))
    const ung = JSON.parse(ungrouped.out)
    assert.equal(ung.total, 3)
    assert.ok(ung.items.every((x) => x.group === ''))
    // 分页：offset 跳过第一条
    const page2 = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { groups: ['技术/甲'], offset: 1, limit: 2 }, H))
    const p2 = JSON.parse(page2.out)
    assert.equal(p2.items.length, 2)
    assert.equal(p2.offset, 1)
    assert.notEqual(p2.items[0].id, sub.items[0].id)
  } finally {
    await srv.close()
  }
})

test('mark-all-read：groups 作用域严格隔离（未分组批量不标记有分组订阅）', async () => {
  const srv = await feedServer({})
  try {
    await invoke(route('feeds/add'), fakeReq('POST', '/dsh-rss/feeds/add', { url: `${srv.origin}/feed.xml`, group: '技术' }, H))
    await invoke(route('feeds/add'), fakeReq('POST', '/dsh-rss/feeds/add', { url: `${srv.origin}/feed2.xml` }, H))
    const r = await invoke(route('feeds/mark-all-read'), fakeReq('POST', '/dsh-rss/feeds/mark-all-read', { groups: [''] }, H))
    const out = JSON.parse(r.out)
    assert.equal(out.ok, true)
    assert.equal(out.marked, 3)
    const grouped = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { groups: ['技术'], filter: 'unread' }, H))
    assert.equal(JSON.parse(grouped.out).total, 3, '分组订阅不受未分组批量操作影响')
    const ungrouped = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { groups: [''], filter: 'unread' }, H))
    assert.equal(JSON.parse(ungrouped.out).total, 0)
  } finally {
    await srv.close()
  }
})

test('groups 空数组=显式空作用域（0 匹配 0 写入，绝不回落全部）；畸形 groups 显式 400', async () => {
  const srv = await feedServer({})
  try {
    await invoke(route('feeds/add'), fakeReq('POST', '/dsh-rss/feeds/add', { url: `${srv.origin}/feed.xml`, group: '技术' }, H))
    await invoke(route('feeds/add'), fakeReq('POST', '/dsh-rss/feeds/add', { url: `${srv.origin}/feed2.xml` }, H))
    // articles：空数组 → 0 匹配（而不是“未提供”回落全部）
    const empty = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { groups: [] }, H))
    const eb = JSON.parse(empty.out)
    assert.equal(eb.ok, true)
    assert.equal(eb.total, 0)
    assert.deepEqual(eb.items, [])
    // mark-all-read：空数组 → 0 写入（任何订阅都不得被标记）
    const mark = await invoke(route('feeds/mark-all-read'), fakeReq('POST', '/dsh-rss/feeds/mark-all-read', { groups: [] }, H))
    assert.equal(JSON.parse(mark.out).marked, 0)
    const unread = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { filter: 'unread' }, H))
    assert.equal(JSON.parse(unread.out).total, 6, '空 groups 绝不解释为“全部”')
    // 畸形 groups：非数组 / 非字符串成员 → 显式 400，而不是静默忽略后放宽作用域
    for (const bad of ['技术', 42, { 0: 'x' }, ['技术', 7], [null], [['技术']]]) {
      const r = await invoke(route('articles'), fakeReq('POST', '/dsh-rss/articles', { groups: bad }, H))
      assert.equal(r.statusCode, 400, `groups=${JSON.stringify(bad)} 应被拒绝`)
      assert.match(JSON.parse(r.out).error, /groups/)
    }
    const rm = await invoke(route('feeds/mark-all-read'), fakeReq('POST', '/dsh-rss/feeds/mark-all-read', { groups: '技术' }, H))
    assert.equal(rm.statusCode, 400, '批量已读同样拒绝畸形 groups')
    assert.equal(JSON.parse(rm.out).marked, undefined, '被拒绝的请求不得有写入结果')
  } finally {
    await srv.close()
  }
})
