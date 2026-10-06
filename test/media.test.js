import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import * as host from '../index.js'
import { imageMime, MediaCache, MEDIA_LIMITS } from '../lib/media.js'
import { fetchBounded } from '../lib/http.js'

// ---------- 图片本地代理：魔数嗅探 / 磁盘缓存 / 路由防护与服务 ----------

// 1x1 透明 PNG（真实魔数，非伪造扩展名）
const PNG_1PX = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050201f34d3f1f0000000049454e44ae426082',
  'hex',
)
// 最小 GIF（1x1）
const GIF_1PX = Buffer.from('474946383961010001008000000000000021f90401000000002c00000000010001000002024401003b', 'hex')
const SVG_XSS = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>')
const HTML_FAKE = Buffer.from('<html><body>not an image</body></html>')

test('imageMime：魔数嗅探（png/gif/jpeg/webp/avif/bmp/ico；SVG 与 HTML 拒绝）', () => {
  assert.equal(imageMime(PNG_1PX), 'image/png')
  assert.equal(imageMime(GIF_1PX), 'image/gif')
  assert.equal(imageMime(Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')), 'image/jpeg')
  assert.equal(imageMime(Buffer.from('52494646241000005745425056503830', 'hex')), 'image/webp')
  assert.equal(imageMime(Buffer.from('000000186674797061766966', 'hex')), 'image/avif')
  assert.equal(imageMime(Buffer.from('424d1a0000000000000036000000', 'hex')), 'image/bmp')
  assert.equal(imageMime(Buffer.from('00000100010010100000000000000000', 'hex')), 'image/x-icon')
  assert.equal(imageMime(SVG_XSS), null, 'SVG 一律不识别（可在插件源上执行脚本）')
  assert.equal(imageMime(HTML_FAKE), null)
  assert.equal(imageMime(Buffer.alloc(4)), null)
  assert.equal(imageMime(null), null)
})

// ---------- 夹具图床 ----------

async function startServer(handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return { server, origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) }
}

function imgServer(state = {}) {
  return startServer((req, res) => {
    state.hits = (state.hits || 0) + 1
    if (req.url === '/ok.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      return res.end(PNG_1PX)
    }
    if (req.url === '/ok.gif') {
      res.writeHead(200, { 'content-type': 'image/gif' })
      return res.end(GIF_1PX)
    }
    if (req.url === '/fake.png') {
      // 扩展名是 png，正文是 HTML：必须按魔数拒绝
      res.writeHead(200, { 'content-type': 'image/png' })
      return res.end(HTML_FAKE)
    }
    if (req.url === '/xss.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' })
      return res.end(SVG_XSS)
    }
    if (req.url === '/gone.png') {
      res.writeHead(404)
      return res.end('nf')
    }
    res.writeHead(404)
    res.end('nf')
  })
}

// ---------- MediaCache ----------

let dir
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-rss-media-'))
})

test('MediaCache：抓取→字节原样（binary 路径）→缓存命中不再发网络请求', async () => {
  const state = {}
  const srv = await imgServer(state)
  try {
    const cache = new MediaCache(join(dir, 'media'))
    const out = await cache.fetch(`${srv.origin}/ok.png`, fetchBounded)
    assert.equal(out.mime, 'image/png')
    assert.ok(out.buffer.equals(PNG_1PX), '二进制必须逐字节一致（不走 utf8 文本解码）')
    const hits = state.hits
    const again = await cache.serve(`${srv.origin}/ok.png`, fetchBounded)
    assert.ok(again.buffer.equals(PNG_1PX))
    assert.equal(state.hits, hits, '第二次必须命中磁盘缓存（不访问图床）')
    const files = await readdir(join(dir, 'media'))
    assert.equal(files.length, 1)
  } finally {
    await srv.close()
  }
})

test('MediaCache：在途去重（并发同一 URL 只发一次请求）', async () => {
  const state = {}
  const srv = await imgServer(state)
  try {
    const cache = new MediaCache(join(dir, 'media'))
    const [a, b] = await Promise.all([
      cache.fetch(`${srv.origin}/ok.png`, fetchBounded),
      cache.fetch(`${srv.origin}/ok.png`, fetchBounded),
    ])
    assert.ok(a.buffer.equals(b.buffer))
    assert.equal(state.hits, 1, '并发去重：图床只收到一次请求')
  } finally {
    await srv.close()
  }
})

test('MediaCache：SVG/伪造图片拒绝；404 单独报错；损坏缓存文件自动剔除', async () => {
  const srv = await imgServer({})
  try {
    const cache = new MediaCache(join(dir, 'media'))
    await assert.rejects(() => cache.fetch(`${srv.origin}/xss.svg`, fetchBounded), /不支持的图片格式|SVG/)
    await assert.rejects(() => cache.fetch(`${srv.origin}/fake.png`, fetchBounded), /不支持的图片格式/)
    await assert.rejects(() => cache.fetch(`${srv.origin}/gone.png`, fetchBounded), /404/)
    // 缓存文件损坏（非图片字节）：lookup 视为未命中并删除文件
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { sha1 } = await import('../lib/util.js')
    await mkdir(join(dir, 'media'), { recursive: true })
    const corruptUrl = `${srv.origin}/corrupt.png`
    await writeFile(join(dir, 'media', `${sha1(corruptUrl)}.img`), Buffer.from('garbage-not-image'))
    assert.equal(await cache.lookup(corruptUrl), null)
    const files = await readdir(join(dir, 'media'))
    assert.equal(files.length, 0, '损坏缓存文件应被删除')
  } finally {
    await srv.close()
  }
})

test('MediaCache：LRU 修剪（超过 100 文件删最旧）', async () => {
  const { mkdir, writeFile, stat } = await import('node:fs/promises')
  const { sha1 } = await import('../lib/util.js')
  const mediaDir = join(dir, 'media')
  await mkdir(mediaDir, { recursive: true })
  const cache = new MediaCache(mediaDir)
  // 预置 102 个"图片"缓存（字节用 PNG_1PX 保证嗅探通过；mtime 递增模拟新旧）
  for (let i = 0; i < 102; i++) {
    const f = join(mediaDir, `${sha1('https://x.example/' + i)}.img`)
    await writeFile(f, PNG_1PX)
    const st = await stat(f)
    const old = new Date(st.mtimeMs - (10000 - i) * 1000)
    await (await import('node:fs/promises')).utimes(f, old, old)
  }
  // 触发一次 _store（写第 103 个）引发修剪
  await cache._store('https://x.example/trigger', PNG_1PX)
  const files = await readdir(mediaDir)
  assert.equal(files.length, MEDIA_LIMITS.MAX_CACHE_FILES, `修剪后应恰好保留 ${MEDIA_LIMITS.MAX_CACHE_FILES} 个文件`)
})

// ---------- host 路由 ----------

let routeDir
let routes
const route = (name) => routes.find((r) => r.path === `/dsh-rss/${name}`)

function fakeReq(method, url, headers = {}) {
  return { method, url, headers }
}

function invoke(r, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0, out: Buffer.alloc(0), headers: {},
      writeHead(code, hdrs) { this.statusCode = code; this.headers = hdrs || {} },
      end(b) { this.out = Buffer.isBuffer(b) ? b : Buffer.from(String(b || '')); resolve(this) },
    }
    Promise.resolve(r.handler(req, res)).catch(reject)
  })
}

test('media 路由：防护（跨站 Sec-Fetch-Site / 跨源 Origin / 非 GET / 非法 URL）', async () => {
  routeDir = await mkdtemp(join(tmpdir(), 'dsh-rss-host-'))
  routes = host.buildRouteTable(host.makeDeps(routeDir))
  const media = route('media')
  assert.ok(media, 'media 路由应存在')

  const bad = await invoke(media, fakeReq('GET', '/dsh-rss/media?u=x', { 'sec-fetch-site': 'cross-site' }))
  assert.equal(bad.statusCode, 403)
  const badOrigin = await invoke(media, fakeReq('GET', '/dsh-rss/media?u=x', { origin: 'http://evil.example', host: '127.0.0.1:1' }))
  assert.equal(badOrigin.statusCode, 403)
  const notGet = await invoke(media, fakeReq('POST', '/dsh-rss/media?u=x', {}))
  assert.equal(notGet.statusCode, 403)
  const badProto = await invoke(media, fakeReq('GET', '/dsh-rss/media?u=' + encodeURIComponent('file:///etc/passwd'), {}))
  assert.equal(badProto.statusCode, 400)
  const noParam = await invoke(media, fakeReq('GET', '/dsh-rss/media', {}))
  assert.equal(noParam.statusCode, 400)
})

test('media 路由：同源 GET 正常服务（字节一致、nosniff+CSP、缓存命中）', async () => {
  const state = {}
  const srv = await imgServer(state)
  routeDir = await mkdtemp(join(tmpdir(), 'dsh-rss-host-'))
  routes = host.buildRouteTable(host.makeDeps(routeDir))
  const media = route('media')
  try {
    const u = encodeURIComponent(`${srv.origin}/ok.png`)
    const r1 = await invoke(media, fakeReq('GET', `/dsh-rss/media?u=${u}`, { 'sec-fetch-site': 'same-origin' }))
    assert.equal(r1.statusCode, 200)
    assert.ok(r1.out.equals(PNG_1PX), '响应字节与源图逐字节一致')
    assert.equal(r1.headers['content-type'], 'image/png')
    assert.equal(r1.headers['x-content-type-options'], 'nosniff')
    assert.ok(String(r1.headers['content-security-policy']).includes("default-src 'none'"))
    assert.ok(String(r1.headers['cache-control']).includes('private'))
    const hits = state.hits
    const r2 = await invoke(media, fakeReq('GET', `/dsh-rss/media?u=${u}`, {}))
    assert.equal(r2.statusCode, 200)
    assert.ok(r2.out.equals(PNG_1PX))
    assert.equal(state.hits, hits, '第二次命中本地缓存')
    // SVG → 415；伪 png（HTML 正文）→ 415
    const svg = await invoke(media, fakeReq('GET', `/dsh-rss/media?u=${encodeURIComponent(`${srv.origin}/xss.svg`)}`, {}))
    assert.equal(svg.statusCode, 415)
    const fake = await invoke(media, fakeReq('GET', `/dsh-rss/media?u=${encodeURIComponent(`${srv.origin}/fake.png`)}`, {}))
    assert.equal(fake.statusCode, 415)
  } finally {
    await srv.close()
  }
})

test('fetchBounded binary：文本模式与二进制模式返回形态', async () => {
  const srv = await imgServer({})
  try {
    const bin = await fetchBounded(`${srv.origin}/ok.png`, { binary: true })
    assert.ok(Buffer.isBuffer(bin.buffer))
    assert.ok(bin.buffer.equals(PNG_1PX))
    assert.equal(bin.text, undefined, '二进制模式不产出 utf8 文本')
    const txt = await fetchBounded(`${srv.origin}/ok.png`, {})
    assert.equal(typeof txt.text, 'string')
    assert.equal(txt.buffer, undefined, '文本模式不产出 buffer')
  } finally {
    await srv.close()
  }
})
