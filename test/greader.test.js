import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GreaderClient, greaderItemToArticle, normalizeApiBase, GREADER_TAGS } from '../lib/greader.js'

function res(status, text) {
  return { status, ok: status >= 200 && status < 300, headers: {}, text, insecure: false, url: 'https://fr.test/api/greader.php' }
}

function fakeGreader(handlers) {
  const calls = []
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts })
    const u = new URL(url)
    if (u.searchParams) void u
    for (const [re, fn] of handlers) {
      if (re.test(url)) return fn({ url, opts, calls })
    }
    return res(404, 'not found')
  }
  return { calls, fetchImpl }
}

function clientWith(fetchImpl, over = {}) {
  return new GreaderClient({ baseUrl: 'https://fr.test', username: 'alice', apiPassword: 'apipw', fetchImpl, ...over })
}

test('normalizeApiBase: 根地址 / /api / 完整 greader.php', () => {
  assert.equal(normalizeApiBase('https://fr.test').base, 'https://fr.test/api/greader.php')
  assert.equal(normalizeApiBase('https://fr.test/api/').base, 'https://fr.test/api/greader.php')
  assert.equal(normalizeApiBase('https://fr.test/api/greader.php').base, 'https://fr.test/api/greader.php')
  assert.equal(normalizeApiBase('https://fr.test/api/greader.php/').base, 'https://fr.test/api/greader.php')
  assert.equal(normalizeApiBase('http://fr.test').insecure, true)
  assert.equal(normalizeApiBase('https://fr.test').insecure, false)
  assert.throws(() => normalizeApiBase('ftp://fr.test'), /http\/https/)
  assert.throws(() => normalizeApiBase('not url'), /地址/)
})

test('login: ClientLogin POST 表单 + Auth 解析 + GoogleLogin 头', async () => {
  const { calls, fetchImpl } = fakeGreader([
    [/accounts\/ClientLogin/, ({ opts }) => {
      const body = String(opts.body)
      assert.ok(body.includes('Email=alice'))
      assert.ok(body.includes('Passwd=apipw'))
      assert.equal(opts.redirect, 'error') // 凭据请求拒绝跨源重定向
      return res(200, 'SID=sid123\nAuth=auth-token-1\n')
    }],
    [/subscription\/list/, () => res(200, JSON.stringify({ subscriptions: [] }))],
  ])
  const c = clientWith(fetchImpl)
  await c.login()
  assert.equal(c.auth, 'auth-token-1')
  await c.subscriptionList()
  assert.ok(calls.some((x) => String(x.opts.headers?.authorization).includes('GoogleLogin auth=auth-token-1')))
})

test('所有携带凭据的请求一律 redirect:error（含 GET）', async () => {
  const { calls, fetchImpl } = fakeGreader([
    [/accounts\/ClientLogin/, () => res(200, 'SID=s\nAuth=t1\n')],
    [/reader\/api\/0\/token/, () => res(200, 'T'.repeat(57))],
    [/subscription\/list/, () => res(200, JSON.stringify({ subscriptions: [] }))],
    [/stream\/contents/, () => res(200, JSON.stringify({ items: [] }))],
  ])
  const c = clientWith(fetchImpl)
  await c.login()
  await c.token()
  await c.subscriptionList()
  await c.streamContents('user/-/state/com.google/reading-list')
  assert.ok(calls.length >= 4, `应有 ≥4 个请求（实际 ${calls.length}）`)
  assert.ok(calls.every((x) => x.opts.redirect === 'error'), '全部请求（含 GET token/list/stream）都必须拒绝重定向，防跨源凭据转发')
})

test('login 失败: 401 报中文错误且不含密码', async () => {
  const { fetchImpl } = fakeGreader([[/ClientLogin/, () => res(401, 'Unauthorized=')]])
  const c = clientWith(fetchImpl)
  await assert.rejects(() => c.login(), (err) => {
    assert.match(err.message, /认证失败/)
    assert.ok(!err.message.includes('apipw'))
    return true
  })
})

test('subscriptionList: 分类 → 分组', async () => {
  const { fetchImpl } = fakeGreader([
    [/ClientLogin/, () => res(200, 'Auth=t1')],
    [/subscription\/list/, () => res(200, JSON.stringify({ subscriptions: [
      { id: 'feed/1', title: '源A', url: 'https://a.example/feed', htmlUrl: 'https://a.example', categories: [{ id: 'user/-/label/技术', label: '技术' }] },
      { id: 'feed/2', title: '源B', url: 'https://b.example/feed', categories: [] },
    ] }))],
  ])
  const c = clientWith(fetchImpl)
  await c.login()
  const subs = await c.subscriptionList()
  assert.equal(subs.length, 2)
  assert.equal(subs[0].externalFeedId, 'feed/1')
  assert.equal(subs[0].group, '技术')
  assert.equal(subs[1].group, '')
})

test('streamContents: continuation 分页与 n/xt 参数', async () => {
  let pageCalls = 0
  const { fetchImpl } = fakeGreader([
    [/ClientLogin/, () => res(200, 'Auth=t1')],
    [/stream\/contents/, ({ url }) => {
      pageCalls++
      const u = new URL(url)
      assert.equal(u.searchParams.get('output'), 'json')
      assert.equal(u.searchParams.get('n'), '100')
      if (pageCalls === 1) {
        assert.equal(u.searchParams.get('xt'), 'user/-/state/com.google/read')
        assert.ok(u.pathname.includes('/reader/api/0/stream/contents/user/-/state/com.google/reading-list'))
        return res(200, JSON.stringify({ items: [{ id: 'tag:google.com,2005:reader/item/0001' }], continuation: '1760000000000' }))
      }
      assert.equal(u.searchParams.get('c'), '1760000000000')
      return res(200, JSON.stringify({ items: [{ id: 'tag:google.com,2005:reader/item/0002' }] }))
    }],
  ])
  const c = clientWith(fetchImpl)
  await c.login()
  const { items, pages } = await c.streamContents('user/-/state/com.google/reading-list', { n: 100, xt: 'user/-/state/com.google/read', maxPages: 2 })
  assert.equal(items.length, 2)
  assert.equal(pages, 'done')
  assert.equal(pageCalls, 2)
})

test('editTags: 先取 token，POST 重复 i/a/T；失败如实抛错', async () => {
  const { calls, fetchImpl } = fakeGreader([
    [/ClientLogin/, () => res(200, 'Auth=t1')],
    [/reader\/api\/0\/token/, () => res(200, 'A'.repeat(57))],
    [/edit-tag/, ({ opts }) => {
      const body = String(opts.body)
      assert.ok(body.includes('i=item-1'))
      assert.ok(body.includes('i=item-2'))
      assert.ok(body.includes(`a=${encodeURIComponent(GREADER_TAGS.READ)}`))
      assert.ok(body.includes('ac=edit'))
      assert.ok(body.includes(`T=${'A'.repeat(57)}`))
      return res(200, 'OK')
    }],
  ])
  const c = clientWith(fetchImpl)
  await c.login()
  const r = await c.editTags({ ids: ['item-1', 'item-2'], add: [GREADER_TAGS.READ] })
  assert.equal(r.count, 2)
  void calls
})

test('editTags: 服务端拒绝时抛错（不假装成功）', async () => {
  const { fetchImpl } = fakeGreader([
    [/ClientLogin/, () => res(200, 'Auth=t1')],
    [/reader\/api\/0\/token/, () => res(200, 'A'.repeat(57))],
    [/edit-tag/, () => res(200, 'ERROR: something')],
  ])
  const c = clientWith(fetchImpl)
  await c.login()
  await assert.rejects(() => c.editTags({ ids: ['x'], add: [GREADER_TAGS.READ] }), /拒绝|edit-tag/)
})

test('markAllRead: ts 为纳秒时间戳', async () => {
  const { fetchImpl } = fakeGreader([
    [/ClientLogin/, () => res(200, 'Auth=t1')],
    [/reader\/api\/0\/token/, () => res(200, 'A'.repeat(57))],
    [/mark-all-as-read/, ({ opts }) => {
      const body = String(opts.body)
      const m = /ts=(\d+)/.exec(body)
      assert.ok(m, '包含 ts')
      assert.ok(m[1].length >= 16, `ts 应为纳秒（得到 ${m[1]}）`)
      assert.ok(body.includes('s=feed%2F12') || body.includes('s=feed/12'))
      return res(200, 'OK')
    }],
  ])
  const c = clientWith(fetchImpl)
  await c.login()
  await c.markAllRead('feed/12', Date.parse('2026-10-01T00:00:00Z'))
})

test('greaderItemToArticle: 分类→已读/收藏、canonical 链接、时间秒→毫秒、内容清理', () => {
  const a = greaderItemToArticle({
    id: 'tag:google.com,2005:reader/item/0000000022',
    title: '标题<script>',
    published: 1760000100,
    updated: 1760000200,
    canonical: [{ href: 'https://origin.example/1' }],
    alternate: [{ href: 'https://alt.example/1' }],
    author: '作者',
    categories: ['user/-/state/com.google/read', 'user/-/state/com.google/starred'],
    origin: { streamId: 'feed/7', title: '来源' },
    summary: { content: '<p>正文</p><script>bad()</script>' },
  })
  assert.equal(a.url, 'https://origin.example/1')
  assert.equal(a.publishedMs, 1760000100000)
  assert.equal(a.greader.read, true)
  assert.equal(a.greader.starred, true)
  assert.equal(a.greader.originStreamId, 'feed/7')
  assert.ok(!a.contentHtml.includes('<script'))
  assert.ok(a.contentText.includes('正文'))
  const b = greaderItemToArticle({ id: 'x', categories: [] })
  assert.equal(b.greader.read, false)
})

test('greaderItemToArticle：危险协议链接被拒绝（javascript:/data:）', () => {
  const a = greaderItemToArticle({
    id: 'bad-1',
    title: '坏链接',
    canonical: [{ href: 'javascript:alert(1)' }],
    alternate: [{ href: 'data:text/html,hi' }],
    enclosure: [{ href: 'vbscript:x', type: 'audio/mpeg' }],
    categories: [],
  })
  assert.equal(a.url, null)
  assert.equal(a.enclosureUrl, null)
  const ok = greaderItemToArticle({
    id: 'ok-1',
    canonical: [{ href: 'https://ok.example/a?b=1' }],
    enclosure: [{ href: 'http://ok.example/x.mp3' }],
    categories: [],
  })
  assert.equal(ok.url, 'https://ok.example/a?b=1')
  assert.equal(ok.enclosureUrl, 'http://ok.example/x.mp3')
})

test('streamContents: ot 增量参数（秒级时间戳）随请求下发', async () => {
  const seen = []
  const { fetchImpl } = fakeGreader([
    [/stream\/contents/, ({ url }) => {
      seen.push(new URL(url).searchParams)
      return res(200, JSON.stringify({ items: [] }))
    }],
  ])
  const c = clientWith(fetchImpl)
  c.auth = 't' // streamContents 需要登录态；这里只验证 ot 参数，不走 ClientLogin
  await c.streamContents('user/-/state/com.google/reading-list', { n: 100 })
  await c.streamContents('user/-/state/com.google/reading-list', { n: 100, ot: 1760000000 })
  assert.equal(seen[0].get('ot'), null, '未提供 ot 时不应下发')
  assert.equal(seen[1].get('ot'), '1760000000', '增量同步应下发 ot（秒）')
})
