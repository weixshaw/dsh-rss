import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, STORE_LIMITS } from '../lib/store.js'
import { stableEntryId } from '../lib/util.js'
import { loadConfig, saveConfig, maskConfig, sanitizeConfigPatch, applyConfigPatch, withConfigLock, accountKeyOf, applyAccountPolicy } from '../lib/config.js'

let dir
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-rss-test-'))
})

async function makeStore() {
  const store = new Store(dir)
  await store.init()
  return store
}

function item(n, over = {}) {
  return {
    externalId: `gid-${n}`,
    title: `文章${n}`,
    url: `https://example.com/${n}`,
    publishedMs: Date.parse(`2026-10-0${(n % 9) + 1}T10:00:00Z`),
    updatedMs: null,
    author: null,
    summaryHtml: `<p>摘要${n}</p>`,
    contentHtml: `<p>正文${n}</p>`,
    contentText: `正文${n}`,
    enclosureUrl: null,
    enclosureType: null,
    ...over,
  }
}

test('addFeed/putArticles/getArticles: 稳定 ID 与合并保留状态', async () => {
  const store = await makeStore()
  const feed = await store.addFeed({ url: 'https://example.com/feed', title: '示例', group: '' })
  const key = 'https://example.com/feed'
  const r1 = await store.putArticles(feed.id, [item(1), item(2), item(3)], { feedKey: key })
  assert.equal(r1.added, 3)

  const page = await store.getArticles({ filter: 'all', limit: 50 })
  assert.equal(page.total, 3)
  const id1 = stableEntryId(key, 'gid-1')
  await store.setMarks(id1, { read: true, starred: true })

  const r2 = await store.putArticles(feed.id, [item(1, { title: '文章1（改）' }), item(4)], { feedKey: key })
  assert.equal(r2.added, 1)
  assert.equal(r2.updated, 1)
  const page2 = await store.getArticles({ filter: 'all', limit: 50 })
  assert.equal(page2.total, 4)
  const a1 = await store.getArticle(id1)
  assert.equal(a1.title, '文章1（改）')
  assert.equal(a1.read, true)
  assert.equal(a1.starred, true)

  assert.equal((await store.getArticles({ filter: 'unread' })).total, 3)
  assert.equal((await store.getArticles({ filter: 'starred' })).total, 1)
  assert.equal((await store.getArticles({ search: '正文4' })).total, 1)
})

test('putArticles: 每订阅上限 100 条（按时间裁剪）', async () => {
  const store = await makeStore()
  const feed = await store.addFeed({ url: 'https://example.com/big', title: 'big' })
  const items = []
  for (let i = 0; i < 130; i++) items.push(item(i + 1, { publishedMs: Date.parse('2026-01-01T00:00:00Z') + i * 1000 }))
  await store.putArticles(feed.id, items, { feedKey: 'https://example.com/big' })
  const page = await store.getArticles({ feedId: feed.id, limit: 100 })
  assert.equal(page.total, 100)
  assert.ok(!page.items.some((a) => a.title === '文章1'))
  assert.equal(page.items[0].title, '文章130')
})

test('setMarks: greader 待推送队列（版本化条目）与同维度互斥', async () => {
  const store = await makeStore()
  const feed = await store.addFeed({ url: 'https://example.com/g', title: 'g', kind: 'greader', externalFeedId: 'feed/9' })
  await store.putArticles(feed.id, [item(11), item(12)], { feedKey: 'feed/9' })
  const id11 = stableEntryId('feed/9', 'gid-11')
  await store.setMarks(id11, { read: true, starred: true })
  let p = store.pendingLists(100)
  assert.deepEqual(p.read.map((e) => e.gid), ['gid-11'])
  assert.deepEqual(p.star.map((e) => e.gid), ['gid-11'])
  assert.ok(p.read[0].at > 0, '条目带版本时间戳')
  // 改回未读 → read 队列清空、unread 入队（同维度互斥）
  await store.setMarks(id11, { read: false })
  p = store.pendingLists(100)
  assert.deepEqual(p.read, [])
  assert.deepEqual(p.unread.map((e) => e.gid), ['gid-11'])
  await store.ackPending('unread', p.unread)
  assert.equal(store.pendingCounts().total, 1) // star 仍在
})

test('ackPending：只删除快照版本，同步期间的新标记不被抹掉', async () => {
  const store = await makeStore()
  const feed = await store.addFeed({ url: 'https://example.com/g', title: 'g', kind: 'greader', externalFeedId: 'feed/9' })
  await store.putArticles(feed.id, [item(21)], { feedKey: 'feed/9' })
  const id = stableEntryId('feed/9', 'gid-21')
  await store.setMarks(id, { read: true })
  const snapshot = store.pendingLists(100) // 模拟同步开始时的快照
  assert.equal(snapshot.read.length, 1)
  // 同步进行中用户再次标记（先撤销再重标 → 生成新版本）
  await store.setMarks(id, { read: false })
  await store.setMarks(id, { read: true })
  const after = store.pendingLists(100)
  assert.equal(after.read.length, 1)
  assert.notEqual(after.read[0].at, snapshot.read[0].at, '应为更新版本')
  // ack 旧快照 → 新版本保留
  await store.ackPending('read', snapshot.read)
  const finalQ = store.pendingLists(100)
  assert.equal(finalQ.read.length, 1)
  assert.equal(finalQ.read[0].at, after.read[0].at)
})

test('applyRemoteMarks：待推送维度本地优先；无待推送时服务端 true/false 都落地', async () => {
  const store = await makeStore()
  const feed = await store.addFeed({ url: 'https://example.com/g', title: 'g', kind: 'greader', externalFeedId: 'feed/9' })
  await store.putArticles(feed.id, [item(31), item(32), item(33)], { feedKey: 'feed/9' })
  const id31 = stableEntryId('feed/9', 'gid-31')
  const id32 = stableEntryId('feed/9', 'gid-32')
  const id33 = stableEntryId('feed/9', 'gid-33')
  // 31：本地已读 + 待推送 read；32：本地已读且推送成功（无待推送）；33：本地已收藏且已推送
  await store.setMarks(id31, { read: true })
  await store.setMarks(id32, { read: true })
  await store.ackPending('read', store.pendingLists(100).read.filter((e) => e.gid === 'gid-32'))
  await store.setMarks(id33, { starred: true })
  await store.ackPending('star', store.pendingLists(100).star.filter((e) => e.gid === 'gid-33'))

  const changed = await store.applyRemoteMarks([
    { id: id31, gid: 'gid-31', read: false, starred: false }, // 服务端未读：本地待推送 read 优先
    { id: id32, gid: 'gid-32', read: false, starred: false }, // 服务端未读 → 如实取消本地已读
    { id: id33, gid: 'gid-33', read: false, starred: true },  // 服务端加星 → 如实落地
  ])
  assert.ok(changed >= 1)
  assert.equal((await store.getArticle(id31)).read, true, '本地待推送的已读不被服务端未读覆盖')
  assert.equal((await store.getArticle(id32)).read, false, '无待推送时服务端未读如实落地')
  assert.equal((await store.getArticle(id33)).starred, true)
})

test('markAllRead 与 setMarks 共用互斥逻辑：先标未读再全部已读 → 只有 read 队列', async () => {
  const store = await makeStore()
  const feed = await store.addFeed({ url: 'https://example.com/g', title: 'g', kind: 'greader', externalFeedId: 'feed/9' })
  await store.putArticles(feed.id, [item(41), item(42)], { feedKey: 'feed/9' })
  const id41 = stableEntryId('feed/9', 'gid-41')
  await store.setMarks(id41, { read: true })
  await store.setMarks(id41, { read: false })
  assert.equal(store.pendingCounts().unread, 1)
  const r = await store.markAllRead({})
  assert.equal(r.marked, 2)
  const p = store.pendingLists(100)
  assert.equal(p.unread.length, 0, '全部已读应清掉 unread 待推送（同维度互斥）')
  assert.deepEqual(p.read.map((e) => e.gid).sort(), ['gid-41', 'gid-42'])
  assert.equal(store.pendingCounts().star, 0)
})

test('AI 结果持久化与同 action 覆盖', async () => {
  const store = await makeStore()
  const feed = await store.addFeed({ url: 'https://example.com/ai', title: 'ai' })
  await store.putArticles(feed.id, [item(31)], { feedKey: 'https://example.com/ai' })
  const id = stableEntryId('https://example.com/ai', 'gid-31')
  await store.saveAiResult(id, { action: 'summary', model: 'm1', text: '摘要一' })
  await store.saveAiResult(id, { action: 'summary', model: 'm2', text: '摘要二（覆盖同 action）' })
  await store.saveAiResult(id, { action: 'translate', model: 'm1', text: '译文' })
  const a = await store.getArticle(id)
  assert.equal(a.aiResults.length, 2)
  assert.ok(a.aiResults.find((r) => r.action === 'summary').text.includes('摘要二'))
})

test('订阅全局上限 MAX_FEEDS', async () => {
  const store = await makeStore()
  for (let i = 0; i < STORE_LIMITS.MAX_FEEDS; i++) {
    await store.addFeed({ url: `https://example.com/f${i}`, title: `f${i}` })
  }
  await assert.rejects(() => store.addFeed({ url: 'https://example.com/over', title: 'over' }), /上限/)
  await assert.rejects(() => store.upsertGreaderFeed({ externalFeedId: 'feed/x', title: 'x' }), /上限/)
})

test('resetGreaderData / removeGreaderFeedsNotIn：清除与保留', async () => {
  const store = await makeStore()
  const stand = await store.addFeed({ url: 'https://example.com/s', title: 'standalone' })
  await store.putArticles(stand.id, [item(1)], { feedKey: 'https://example.com/s' })
  const g1 = await store.upsertGreaderFeed({ externalFeedId: 'feed/1', title: 'g1', group: '技术' })
  const g2 = await store.upsertGreaderFeed({ externalFeedId: 'feed/2', title: 'g2' })
  await store.putArticles(g1.id, [item(11)], { feedKey: 'feed/1' })
  await store.putArticles(g2.id, [item(21)], { feedKey: 'feed/2' })
  const id11 = stableEntryId('feed/1', 'gid-11')
  await store.setMarks(id11, { read: true })
  const removed = await store.removeGreaderFeedsNotIn(['feed/2'])
  assert.equal(removed, 1)
  assert.equal((await store.listFeeds()).filter((f) => f.kind === 'greader').length, 1)
  assert.equal(await store.getArticle(id11), null)
  const id21 = stableEntryId('feed/2', 'gid-21')
  await store.setMarks(id21, { read: true })
  assert.ok(store.pendingCounts().total >= 1)
  const r = await store.resetGreaderData()
  assert.equal(r.feeds, 1)
  assert.equal(r.articles, 1)
  const feeds = await store.listFeeds()
  assert.equal(feeds.length, 1)
  assert.equal(feeds[0].kind, 'standalone')
  assert.equal(store.pendingCounts().total, 0)
})

test('存储文件权限 0600（含按订阅分文件的文章缓存）', async () => {
  const store = await makeStore()
  const feed = await store.addFeed({ url: 'https://example.com/p', title: 'p' })
  await store.putArticles(feed.id, [item(41)], { feedKey: 'https://example.com/p' })
  await store.setMarks(stableEntryId('https://example.com/p', 'gid-41'), { read: true })
  const stat = await import('node:fs/promises').then((m) => m.stat)
  for (const f of ['subscriptions.json', 'state.json', `articles/${feed.id}.json`]) {
    const st = await stat(join(dir, f))
    assert.equal(st.mode & 0o777, 0o600, `${f} 应为 0600`)
  }
  const dirSt = await stat(join(dir, 'articles'))
  assert.equal(dirSt.mode & 0o777, 0o700, 'articles 目录应为 0700')
})

test('写失败显式上抛（不静默吞掉）且串行链保持可用', async () => {
  const store = await makeStore()
  const feed = await store.addFeed({ url: 'https://example.com/p', title: 'p' })
  // 用目录占位目标文件 → rename 失败
  await rm(join(dir, 'subscriptions.json'))
  await mkdir(join(dir, 'subscriptions.json'))
  await assert.rejects(() => store.addFeed({ url: 'https://example.com/q', title: 'q' }))
  // 恢复后下一次 save 仍可执行（串行链未卡死）
  await rm(join(dir, 'subscriptions.json'), { recursive: true })
  await writeFile(join(dir, 'subscriptions.json'), JSON.stringify({ version: 1, feeds: [feed] }))
  const store2 = new Store(dir)
  await store2.init()
  const feed2 = await store2.addFeed({ url: 'https://example.com/q', title: 'q' })
  assert.ok(feed2.id)
})

test('状态文件损坏：显式报错而非静默重置（legacy 单文件与分文件都如此）', async () => {
  const store = await makeStore()
  const feed = await store.addFeed({ url: 'https://example.com/p', title: 'p' })
  await store.putArticles(feed.id, [item(51)], { feedKey: 'https://example.com/p' })
  // 分文件损坏：init（预加载全部分文件）即显式报错
  await writeFile(join(dir, `articles/${feed.id}.json`), '{broken json')
  await assert.rejects(() => new Store(dir).init(), /损坏/)
  // legacy 单文件损坏：迁移读取时显式报错
  const dir2 = await mkdtemp(join(tmpdir(), 'dsh-rss-test-'))
  await mkdir(join(dir2, 'articles'), { recursive: true })
  await writeFile(join(dir2, 'articles.json'), '{broken json')
  await assert.rejects(() => new Store(dir2).init(), /损坏/)
})

// ---------- 按订阅分文件存储：迁移 / 文件生命周期 / 跨订阅并发 ----------

test('迁移：legacy articles.json → articles/<feedId>.json（幂等、保留已读、改名备份）', async () => {
  // 预置旧版布局：直接构造 legacy 单文件（两个订阅的条目）
  const feedA = { id: 'faaaaaaaaaaaaaaa1', kind: 'standalone', url: 'https://a.example/feed', title: 'A', group: '', siteUrl: null, addedAt: 1, lastFetched: 1, lastError: null }
  const feedB = { id: 'gaaaaaaaaaaaaaaa1', kind: 'greader', url: 'feed/1', externalFeedId: 'feed/1', title: 'B', group: '组', siteUrl: null, addedAt: 1, lastFetched: 1, lastError: null }
  await mkdir(join(dir, 'articles'), { recursive: true })
  await writeFile(join(dir, 'subscriptions.json'), JSON.stringify({ version: 1, feeds: [feedA, feedB] }))
  await writeFile(join(dir, 'state.json'), JSON.stringify({ version: 1, read: {}, starred: {}, pendingFresh: { read: [], unread: [], star: [], unstar: [] }, aiResults: {} }))
  const artA = { id: stableEntryId('https://a.example/feed', 'ga-1'), externalId: 'ga-1', title: '旧文章A', url: null, publishedMs: 1000, updatedMs: 1000, author: null, summaryHtml: '', contentHtml: '<p>a</p>', contentText: 'a', enclosureUrl: null, enclosureType: null, fetchedAt: 1 }
  const artB = { id: stableEntryId('feed/1', 'gb-1'), externalId: 'gb-1', title: '旧文章B', url: null, publishedMs: 2000, updatedMs: 2000, author: null, summaryHtml: '', contentHtml: '<p>b</p>', contentText: 'b', enclosureUrl: null, enclosureType: null, fetchedAt: 1 }
  await writeFile(join(dir, 'articles.json'), JSON.stringify({ version: 1, byFeed: { [feedA.id]: [artA], [feedB.id]: [artB] } }))

  const store = new Store(dir)
  await store.init()
  // 分文件可读、内容来自 legacy
  const page = await store.getArticles({ filter: 'all' })
  assert.equal(page.total, 2)
  // legacy 已改名备份、原路径不再存在
  const names = await readdir(dir)
  assert.ok(names.includes('articles.json.migrated-v1'), 'legacy 应改名为 .migrated-v1')
  assert.ok(!names.includes('articles.json'), '原 articles.json 不应残留')
  // 已读状态在迁移后仍可正常读写
  await store.setMarks(artA.id, { read: true })
  assert.equal((await store.getArticles({ filter: 'unread' })).total, 1)
  // 迁移后新写入只落分文件；再次 init（幂等）不回滚
  await store.putArticles(feedA.id, [{ ...artA, id: stableEntryId('https://a.example/feed', 'ga-2'), externalId: 'ga-2', title: '新文章A2' }], { feedKey: 'https://a.example/feed' })
  await new Store(dir).init()
  assert.equal((await store.getArticles({ feedId: feedA.id })).total, 2)
})

test('removeFeed / resetGreaderData：删除对应分文件（不残留孤儿文件）', async () => {
  const store = await makeStore()
  const feed = await store.addFeed({ url: 'https://example.com/x', title: 'x' })
  await store.putArticles(feed.id, [item(61)], { feedKey: 'https://example.com/x' })
  assert.ok((await readdir(join(dir, 'articles'))).includes(`${feed.id}.json`))
  await store.removeFeed(feed.id)
  assert.ok(!(await readdir(join(dir, 'articles'))).includes(`${feed.id}.json`), '退订后分文件应删除')
  assert.equal((await store.getArticles({ filter: 'all' })).total, 0)
})

test('跨订阅并发写互不干扰（分文件独立写队列）', async () => {
  const store = await makeStore()
  const f1 = await store.addFeed({ url: 'https://example.com/c1', title: 'c1' })
  const f2 = await store.addFeed({ url: 'https://example.com/c2', title: 'c2' })
  await Promise.all([
    store.putArticles(f1.id, [item(71), item(72)], { feedKey: 'https://example.com/c1' }),
    store.putArticles(f2.id, [item(73)], { feedKey: 'https://example.com/c2' }),
  ])
  assert.equal((await store.getArticles({ feedId: f1.id })).total, 2)
  assert.equal((await store.getArticles({ feedId: f2.id })).total, 1)
  // 落盘内容各自正确
  const file1 = JSON.parse(await readFile(join(dir, `articles/${f1.id}.json`), 'utf8'))
  const file2 = JSON.parse(await readFile(join(dir, `articles/${f2.id}.json`), 'utf8'))
  assert.equal(file1.length, 2)
  assert.equal(file2.length, 1)
})

test('config: 掩码视图不含密钥；补丁校验；空串清除', async () => {
  await saveConfig(dir, applyConfigPatch(await loadConfig(dir), sanitizeConfigPatch({
    freshrss: { baseUrl: 'http://192.168.1.10/freshrss', username: 'alice', apiPassword: 'secret-pw', enabled: true },
    ai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-test', enabled: true },
  })))
  const cfg = await loadConfig(dir)
  assert.equal(cfg.freshrss.apiPassword, 'secret-pw')
  const masked = maskConfig(cfg)
  assert.ok(!JSON.stringify(masked).includes('secret-pw'))
  assert.ok(!JSON.stringify(masked).includes('sk-test'))
  assert.equal(masked.freshrss.hasApiPassword, true)
  assert.equal(masked.ai.hasApiKey, true)
  assert.equal(masked.freshrss.insecureHttp, true)
  assert.equal(masked.freshrss.configured, true)
  assert.equal(masked.freshrss.needsReset, false)
  assert.throws(() => sanitizeConfigPatch({ freshrss: { baseUrl: 'ftp://x' } }), /http\/https/)
  const cleared = applyConfigPatch(cfg, sanitizeConfigPatch({ freshrss: { apiPassword: '' } }))
  assert.equal(cleared.freshrss.apiPassword, '')
  const st = await import('node:fs/promises').then((m) => m.stat(join(dir, 'config.json')))
  assert.equal(st.mode & 0o777, 0o600)
})

test('config: 并发补丁事务串行化（不丢更新）', async () => {
  await saveConfig(dir, applyConfigPatch(await loadConfig(dir), sanitizeConfigPatch({
    freshrss: { baseUrl: 'https://a.test', username: 'alice', apiPassword: 'pw1', enabled: true },
  })))
  await Promise.all([
    withConfigLock(dir, async () => {
      const cur = await loadConfig(dir)
      await saveConfig(dir, applyConfigPatch(cur, sanitizeConfigPatch({ ai: { baseUrl: 'https://ai.test/v1', model: 'm', apiKey: 'k1', enabled: true } })))
    }),
    withConfigLock(dir, async () => {
      const cur = await loadConfig(dir)
      await saveConfig(dir, applyConfigPatch(cur, sanitizeConfigPatch({ ai: { model: 'm2', apiKey: 'k2' } })))
    }),
  ])
  const final = await loadConfig(dir)
  assert.equal(final.ai.model, 'm2')
  assert.equal(final.ai.apiKey, 'k2')
  assert.equal(final.ai.baseUrl, 'https://ai.test/v1', '第二个事务不应丢掉第一个事务的字段')
})

test('accountKeyOf：仅规范化协议/主机/默认端口；路径与用户名保留大小写', () => {
  assert.notEqual(accountKeyOf('https://fr.test/A', 'u'), accountKeyOf('https://fr.test/a', 'u'), '路径大小写不同不得合并')
  assert.equal(accountKeyOf('https://FR.test/A/', 'u'), accountKeyOf('https://fr.test/A', 'u'), '主机大小写与结尾斜杠应规范化')
  assert.equal(accountKeyOf('https://fr.test:443/A', 'u'), accountKeyOf('https://fr.test/A', 'u'), '默认端口应去除')
  assert.notEqual(accountKeyOf('https://fr.test', 'Alice'), accountKeyOf('https://fr.test', 'alice'), '用户名大小写不同不得合并')
  assert.equal(accountKeyOf('https://fr.test/api/greader.php', 'u'), accountKeyOf('https://fr.test', 'u'), '文档化的 /api/greader.php 与根等价')
  assert.equal(accountKeyOf('https://fr.test/api/', 'u'), accountKeyOf('https://fr.test/api', 'u'))
  assert.notEqual(accountKeyOf('https://fr.test/freshrss', 'u'), accountKeyOf('https://fr.test/FreshRSS', 'u'), '不同子路径安装不得合并')
})

test('config: FreshRSS 账号变更 → needsReset + 未随补丁提供密码时清空旧密码', async () => {
  const base = applyConfigPatch(await loadConfig(dir), sanitizeConfigPatch({
    freshrss: { baseUrl: 'https://a.test', username: 'alice', apiPassword: 'pw1', enabled: true },
  }))
  const withKey = applyAccountPolicy({ freshrss: null }, base, true)
  assert.equal(withKey.freshrss.accountKey, accountKeyOf('https://a.test', 'alice'))
  const changed = applyConfigPatch(withKey, sanitizeConfigPatch({ freshrss: { baseUrl: 'https://b.test', username: 'bob' } }))
  const out = applyAccountPolicy(withKey, changed, false)
  assert.equal(out.freshrss.needsReset, true)
  assert.equal(out.freshrss.apiPassword, '')
  const changed2 = applyConfigPatch(withKey, sanitizeConfigPatch({ freshrss: { baseUrl: 'https://b.test', username: 'bob', apiPassword: 'pw2' } }))
  const out2 = applyAccountPolicy(withKey, changed2, true)
  assert.equal(out2.freshrss.needsReset, true)
  assert.equal(out2.freshrss.apiPassword, 'pw2')
})

// ---------- 分组集合（groups）与每订阅真实计数 ----------

test('getArticles：groups 集合按成员精确匹配（含未分组空串桶、子树多分组），优先于 group', async () => {
  const store = await makeStore()
  const f1 = await store.addFeed({ url: 'https://g1.test/feed', title: '甲', group: '技术/前端' })
  const f2 = await store.addFeed({ url: 'https://g2.test/feed', title: '乙', group: '技术/后端' })
  const f3 = await store.addFeed({ url: 'https://g3.test/feed', title: '丙', group: '' })
  await store.putArticles(f1.id, [item(1)])
  await store.putArticles(f2.id, [item(2)])
  await store.putArticles(f3.id, [item(3)])

  // 子树：客户端把「技术」展开为实际存在的分组串集合
  assert.equal((await store.getArticles({ groups: ['技术/前端', '技术/后端'] })).total, 2)
  // 未分组桶：显式空串（区别于 falsy group=全部）
  assert.equal((await store.getArticles({ groups: [''] })).total, 1)
  assert.equal((await store.getArticles({ groups: [''] })).items[0].feedTitle, '丙')
  // groups 优先于 legacy group 精确串
  assert.equal((await store.getArticles({ group: '技术/前端', groups: [''] })).total, 1)
  // 旧语义不回归：group 精确匹配，falsy=全部
  assert.equal((await store.getArticles({ group: '技术/前端' })).total, 1)
  assert.equal((await store.getArticles({})).total, 3)
  // 与筛选/搜索组合
  assert.equal((await store.getArticles({ groups: ['技术/前端', '技术/后端'], search: '正文2' })).total, 1)
})

test('markAllRead：groups 作用域只标记成员订阅，绝不动其他分组', async () => {
  const store = await makeStore()
  const f1 = await store.addFeed({ url: 'https://g1.test/feed', title: '甲', group: '技术' })
  const f2 = await store.addFeed({ url: 'https://g2.test/feed', title: '乙', group: '' })
  await store.putArticles(f1.id, [item(1), item(2)])
  await store.putArticles(f2.id, [item(3), item(4)])

  const out = await store.markAllRead({ groups: ['技术'] })
  assert.equal(out.marked, 2)
  assert.equal((await store.getArticles({ feedId: f2.id, filter: 'unread' })).total, 2, '未分组订阅不受影响')
  assert.equal((await store.getArticles({ feedId: f1.id, filter: 'unread' })).total, 0)

  const out2 = await store.markAllRead({ groups: [''] })
  assert.equal(out2.marked, 2)
  assert.equal((await store.getArticles({ filter: 'unread' })).total, 0)
})

test('feedCounts：每订阅真实计数由缓存与已读/收藏状态推导', async () => {
  const store = await makeStore()
  const f1 = await store.addFeed({ url: 'https://g1.test/feed', title: '甲', group: '技术' })
  const f2 = await store.addFeed({ url: 'https://g2.test/feed', title: '乙' })
  await store.putArticles(f1.id, [item(1), item(2)])
  await store.putArticles(f2.id, [item(3)])
  const a1 = (await store.getArticles({ feedId: f1.id })).items[0]
  await store.setMarks(a1.id, { read: true, starred: true })

  const counts = await store.feedCounts()
  assert.deepEqual(counts[f1.id], { total: 2, unread: 1, starred: 1 })
  assert.deepEqual(counts[f2.id], { total: 1, unread: 1, starred: 0 })
})

test('groups 空数组=显式空作用域（0 匹配 0 写入）；分组按原始串精确匹配（含纯空白）', async () => {
  const store = await makeStore()
  const f1 = await store.addFeed({ url: 'https://e1.test/f', title: '甲', group: '技术' })
  const f2 = await store.addFeed({ url: 'https://e2.test/f', title: '乙', group: '   ' }) // 纯空白分组
  const f3 = await store.addFeed({ url: 'https://e3.test/f', title: '丙', group: '' })
  await store.putArticles(f1.id, [item(1)])
  await store.putArticles(f2.id, [item(2)])
  await store.putArticles(f3.id, [item(3)])

  // 空数组：0 匹配，绝不回落「全部」
  assert.equal((await store.getArticles({ groups: [] })).total, 0)
  const r0 = await store.markAllRead({ groups: [] })
  assert.equal(r0.marked, 0, '空 groups 批量已读 = 0 写入')
  assert.equal((await store.getArticles({ filter: 'unread' })).total, 3, '空 groups 不得标记任何文章')

  // 原始串精确匹配：'   ' 只匹配 '   '、'' 只匹配 ''（把规范化空组展开为 ['','  ',…] 是客户端职责）
  assert.equal((await store.getArticles({ groups: ['   '] })).total, 1)
  assert.equal((await store.getArticles({ groups: ['   '] })).items[0].feedTitle, '乙')
  assert.equal((await store.getArticles({ groups: [''] })).total, 1)
  assert.equal((await store.getArticles({ groups: [''] })).items[0].feedTitle, '丙')
  // 客户端把未分组桶展开为全部原始空串后：两条未分组订阅一起批量，有分组的甲不受影响
  const out = await store.markAllRead({ groups: ['', '   '] })
  assert.equal(out.marked, 2)
  assert.equal((await store.getArticles({ filter: 'unread' })).total, 1, '甲（group=技术）不被未分组批量触碰')
})
