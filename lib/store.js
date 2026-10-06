import { mkdir, readFile, writeFile, rename, chmod, rm, unlink, readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { RssError, sha1, stableEntryId, clampInt, clampStr } from './util.js'
import { textExcerpt } from './sanitize.js'

/**
 * 本地有界存储（全部位于插件状态目录，0700 目录 / 0600 文件，原子写 + 每文件串行写队列）：
 * - subscriptions.json：订阅列表（standalone RSS 与 greader 两种 kind），全局上限 MAX_FEEDS
 * - articles/<feedId>.json：按订阅分文件缓存的条目（每订阅上限 MAX_PER_FEED，按时间裁剪）。
 *   分文件使「刷新一个订阅」只重写该订阅自己的文件（每文件独立写队列，跨订阅可并发），
 *   而不是整库重写；旧版单文件 articles.json 在 init 时一次性迁移（成功后改名 .migrated-v1 保留备份）。
 * - state.json：已读/收藏（各上限 MAX_READ_IDS）、待推送 FreshRSS 的标记（每队列 MAX_PENDING）、AI 结果（MAX_AI_RESULTS）
 *
 * 条目主键为稳定 ID（订阅键 + guid/link），刷新时按 ID 合并保留已读/收藏状态。
 * 待推送队列按维度互斥（read/unread、star/unstar），并以 {gid, at} 版本化确认：
 * 同步期间的快照 ack 不会抹掉更新的标记。损坏的状态文件会显式报错而不是静默重置。
 */

const MAX_FEEDS = 200
const MAX_PER_FEED = 100
const MAX_READ_IDS = 5000
const MAX_AI_RESULTS = 200
const MAX_PENDING = 2000
const ARTICLE_TEXT_MAX = 600 * 1024

export const STORE_LIMITS = { MAX_FEEDS, MAX_PER_FEED, MAX_READ_IDS, MAX_AI_RESULTS, MAX_PENDING }

/** 读 JSON：不存在返回 null；存在但损坏抛错（不静默吞掉）。 */
async function readJson(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null
    throw err
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new RssError(`状态文件损坏：${basename(file)}（请修复或删除该文件后重试）`)
  }
}

class JsonFile {
  constructor(file) {
    this.file = file
    this.queue = Promise.resolve()
    this.data = null
    this.lastError = null
  }
  async load(fallback) {
    if (this.data === null) {
      const parsed = await readJson(this.file)
      this.data = parsed === null ? fallback : parsed
    }
    return this.data
  }
  /**
   * 串行原子写：失败会上抛（调用方可见），但写队列保持可用（下一次 save 仍会执行）。
   * 临时文件名含 pid+时间戳+随机数，失败时清理。
   */
  save(data) {
    this.data = data
    const write = async () => {
      const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      try {
        await writeFile(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 })
        try { await chmod(tmp, 0o600) } catch { /* 平台差异，尽力 */ }
        await rename(tmp, this.file)
        this.lastError = null
      } catch (err) {
        await unlink(tmp).catch(() => { /* 临时文件可能未创建 */ })
        this.lastError = err
        throw err
      }
    }
    const run = this.queue.then(write, write) // 前一次失败也继续排队，保持串行
    this.queue = run.catch(() => { /* 链保持可用；错误由 run 上抛 */ })
    return run
  }
}

/** 同维度互斥的待推送队列。 */
const QUEUE_DIMS = { read: ['read', 'unread'], unread: ['read', 'unread'], star: ['star', 'unstar'], unstar: ['star', 'unstar'] }

export class Store {
  constructor(dir) {
    this.dir = dir
    this.initialized = false
    this.initPromise = null
    this._lastTick = 0
    this.feedsFile = new JsonFile(join(dir, 'subscriptions.json'))
    this.stateFile = new JsonFile(join(dir, 'state.json'))
    this.articlesDir = join(dir, 'articles')
    this.articleFiles = new Map() // feedId -> JsonFile（articles/<feedId>.json）
  }

  /** 订阅文章文件（文件名只信内部生成的 [A-Za-z0-9_-] ID；异常 ID 一律哈希兜底，不进路径）。 */
  _af(feedId) {
    const key = String(feedId)
    const safe = /^[A-Za-z0-9_-]{1,64}$/.test(key) ? key : `x${sha1(key).slice(0, 16)}`
    let file = this.articleFiles.get(safe)
    if (!file) {
      file = new JsonFile(join(this.articlesDir, `${safe}.json`))
      this.articleFiles.set(safe, file)
    }
    return file
  }

  /** 某订阅的条目数组（首次访问时加载；损坏文件显式抛错）。 */
  async _articles(feedId) {
    const file = this._af(feedId)
    await file.load([])
    return file.data
  }

  /** 删除某订阅的文章文件与内存缓存（订阅移除/重置时）。 */
  async _deleteArticleFile(feedId) {
    const key = String(feedId)
    const safe = /^[A-Za-z0-9_-]{1,64}$/.test(key) ? key : `x${sha1(key).slice(0, 16)}`
    this.articleFiles.delete(safe)
    await unlink(join(this.articlesDir, `${safe}.json`)).catch(() => { /* 文件可能不存在 */ })
  }

  /** 单调递增时间戳：同一毫秒内的两次标记也能区分版本（版本化 ack 依赖它）。 */
  _tick() {
    this._lastTick = Math.max(Date.now(), this._lastTick + 1)
    return this._lastTick
  }

  async init() {
    if (this.initialized) return this
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await mkdir(this.dir, { recursive: true, mode: 0o700 })
        try { await chmod(this.dir, 0o700) } catch { /* 尽力 */ }
        await mkdir(this.articlesDir, { recursive: true, mode: 0o700 })
        try { await chmod(this.articlesDir, 0o700) } catch { /* 尽力 */ }
        // 一次性迁移：旧版单文件 articles.json → articles/<feedId>.json。
        // 幂等：逐文件写完才改名 legacy；中途崩溃则下次以 legacy 为准重放（迁移完成前
        // init 失败、不会有更新写到分文件）。改名后保留 .migrated-v1 作备份，不再读取。
        const legacyPath = join(this.dir, 'articles.json')
        const legacy = await readJson(legacyPath)
        if (legacy && typeof legacy === 'object' && legacy.byFeed && typeof legacy.byFeed === 'object') {
          for (const [feedId, items] of Object.entries(legacy.byFeed)) {
            if (!Array.isArray(items)) continue
            const file = new JsonFile(join(this.articlesDir, `${feedId}.json`))
            file.data = items
            await file.save(items)
          }
          await rename(legacyPath, `${legacyPath}.migrated-v1`).catch(() => { /* 极端情况下下次重放 */ })
        }
        // 预加载既有分文件（损坏在此显式报错，与旧行为一致：启动即可见，而非查询时才炸）
        for (const name of await readdir(this.articlesDir).catch(() => [])) {
          if (!name.endsWith('.json')) continue
          const file = new JsonFile(join(this.articlesDir, name))
          await file.load([])
          this.articleFiles.set(name.slice(0, -5), file)
        }
        await this.feedsFile.load({ version: 1, feeds: [] })
        await this.stateFile.load({ version: 1, read: {}, starred: {}, pendingFresh: { read: [], unread: [], star: [], unstar: [] }, aiResults: {}, meta: {} })
        this.initialized = true
      })()
    }
    await this.initPromise
    return this
  }

  // ---------- 订阅 ----------

  async listFeeds() {
    await this.init()
    return this.feedsFile.data.feeds.map((f) => ({ ...f }))
  }

  async getFeed(id) {
    const feeds = await this.listFeeds()
    return feeds.find((f) => f.id === id) || null
  }

  async addFeed(feed) {
    await this.init()
    const feeds = this.feedsFile.data.feeds
    if (feeds.some((f) => f.url === feed.url || (feed.externalFeedId && f.externalFeedId === feed.externalFeedId))) {
      const err = new Error('订阅已存在（URL 重复）')
      err.code = 'DUPLICATE'
      throw err
    }
    if (feeds.length >= MAX_FEEDS) {
      throw new RssError(`订阅数量已达上限（${MAX_FEEDS}），请先退订部分订阅`)
    }
    const row = {
      id: feed.id || `f${sha1(feed.url).slice(0, 16)}`,
      kind: feed.kind === 'greader' ? 'greader' : 'standalone',
      url: feed.url,
      externalFeedId: feed.externalFeedId || null,
      title: clampStr(feed.title || feed.url, 300),
      group: clampStr(feed.group || '', 300),
      siteUrl: feed.siteUrl || null,
      addedAt: feed.addedAt || Date.now(),
      lastFetched: feed.lastFetched || null,
      lastError: null,
    }
    feeds.push(row)
    await this.feedsFile.save(this.feedsFile.data)
    return { ...row }
  }

  async updateFeed(id, patch) {
    await this.init()
    const feeds = this.feedsFile.data.feeds
    const row = feeds.find((f) => f.id === id)
    if (!row) throw new Error('订阅不存在')
    if ('title' in patch) row.title = clampStr(patch.title, 300)
    if ('group' in patch) row.group = clampStr(patch.group, 300)
    if ('lastFetched' in patch) row.lastFetched = patch.lastFetched
    if ('lastError' in patch) row.lastError = patch.lastError ? clampStr(patch.lastError, 300) : null
    if ('externalFeedId' in patch) row.externalFeedId = patch.externalFeedId || null
    // HTTP 条件请求缓存（ETag / Last-Modified）：null = 服务端不再提供，显式清除
    if ('etag' in patch) row.etag = patch.etag ? clampStr(patch.etag, 500) : null
    if ('lastModified' in patch) row.lastModified = patch.lastModified ? clampStr(patch.lastModified, 200) : null
    await this.feedsFile.save(this.feedsFile.data)
    return { ...row }
  }

  async upsertGreaderFeed(sub) {
    await this.init()
    const feeds = this.feedsFile.data.feeds
    const id = `g${sha1(sub.externalFeedId).slice(0, 16)}`
    let row = feeds.find((f) => f.kind === 'greader' && f.externalFeedId === sub.externalFeedId)
    if (!row) {
      if (feeds.length >= MAX_FEEDS) {
        throw new RssError(`订阅数量已达上限（${MAX_FEEDS}），跳过 FreshRSS 新订阅 ${sub.title || sub.externalFeedId}`)
      }
      row = {
        id, kind: 'greader', url: sub.url || sub.externalFeedId, externalFeedId: sub.externalFeedId,
        title: clampStr(sub.title || sub.url || sub.externalFeedId, 300), group: clampStr(sub.group || '', 300),
        siteUrl: sub.siteUrl || null, addedAt: Date.now(), lastFetched: null, lastError: null,
      }
      feeds.push(row)
    } else {
      row.title = clampStr(sub.title || row.title, 300)
      row.group = clampStr(sub.group ?? row.group, 300)
      row.url = sub.url || row.url
    }
    await this.feedsFile.save(this.feedsFile.data)
    return { ...row }
  }

  async removeFeed(id) {
    await this.init()
    const feeds = this.feedsFile.data.feeds
    const idx = feeds.findIndex((f) => f.id === id)
    if (idx < 0) throw new Error('订阅不存在')
    const [removed] = feeds.splice(idx, 1)
    await this._dropArticleStates([id]) // 先清状态（依赖缓存条目 id）
    await this._deleteArticleFile(id)
    await this.feedsFile.save(this.feedsFile.data)
    return removed
  }

  /** FreshRSS 同步：移除服务端已不存在的 greader 订阅（连同缓存与状态）。 */
  async removeGreaderFeedsNotIn(keepExternalIds) {
    await this.init()
    const keep = new Set(keepExternalIds || [])
    const remove = this.feedsFile.data.feeds.filter((f) => f.kind === 'greader' && !keep.has(f.externalFeedId))
    if (!remove.length) return 0
    const removeIds = remove.map((f) => f.id)
    await this._dropArticleStates(removeIds) // 先清状态（依赖缓存条目 id）
    this.feedsFile.data.feeds = this.feedsFile.data.feeds.filter((f) => !removeIds.includes(f.id))
    for (const id of removeIds) await this._deleteArticleFile(id)
    await this.feedsFile.save(this.feedsFile.data)
    return remove.length
  }

  /** FreshRSS 账号变更确认：清除全部 greader 订阅/缓存/状态/待推送队列（保留 standalone）。 */
  async resetGreaderData() {
    await this.init()
    const gfeeds = this.feedsFile.data.feeds.filter((f) => f.kind === 'greader')
    const ids = gfeeds.map((f) => f.id)
    let removedArticles = 0
    for (const id of ids) removedArticles += (await this._articles(id)).length
    await this._dropArticleStates(ids) // 先清状态（依赖缓存条目 id）
    this.feedsFile.data.feeds = this.feedsFile.data.feeds.filter((f) => f.kind !== 'greader')
    for (const id of ids) await this._deleteArticleFile(id)
    this.stateFile.data.pendingFresh = { read: [], unread: [], star: [], unstar: [] }
    await this.feedsFile.save(this.feedsFile.data)
    await this.stateFile.save(this.stateFile.data)
    return { feeds: gfeeds.length, articles: removedArticles }
  }

  /** 删除一组订阅的本地状态（已读/收藏/AI 结果），不动 pendingFresh。 */
  async _dropArticleStates(feedIds) {
    const state = this.stateFile.data
    const dead = new Set()
    for (const fid of feedIds) {
      for (const a of await this._articles(fid)) dead.add(a.id)
    }
    if (!dead.size) return
    for (const id of dead) {
      delete state.read[id]
      delete state.starred[id]
      delete state.aiResults[id]
    }
    await this.stateFile.save(state)
  }

  // ---------- 条目 ----------

  /**
   * 合并写入一批条目：按稳定 ID 合并（保留已读/收藏），更新变化内容，
   * 每订阅按发布时间保留最新 MAX_PER_FEED 条。只重写该订阅自己的分文件。
   */
  async putArticles(feedId, items, { feedKey } = {}) {
    await this.init()
    const key = feedKey ?? feedId
    const file = this._af(feedId)
    await file.load([])
    const prev = new Map((file.data || []).map((a) => [a.id, a]))
    let added = 0
    let updated = 0
    let kept = 0
    for (const item of items) {
      const id = stableEntryId(key, item.externalId)
      const fresh = {
        id,
        externalId: item.externalId,
        title: clampStr(item.title, 500),
        url: item.url || null,
        publishedMs: item.publishedMs ?? null,
        updatedMs: item.updatedMs ?? item.publishedMs ?? null,
        author: item.author || null,
        summaryHtml: clampStr(item.summaryHtml || '', ARTICLE_TEXT_MAX),
        contentHtml: clampStr(item.contentHtml || '', ARTICLE_TEXT_MAX),
        contentText: clampStr(item.contentText || '', ARTICLE_TEXT_MAX),
        enclosureUrl: item.enclosureUrl || null,
        enclosureType: item.enclosureType || null,
        fetchedAt: Date.now(),
      }
      const old = prev.get(id)
      if (!old) {
        prev.set(id, fresh)
        added++
      } else if (old.title !== fresh.title || old.contentHtml !== fresh.contentHtml || old.url !== fresh.url) {
        prev.set(id, { ...old, ...fresh, publishedMs: fresh.publishedMs ?? old.publishedMs, url: fresh.url || old.url })
        updated++
      } else {
        prev.set(id, { ...old, fetchedAt: fresh.fetchedAt, url: fresh.url || old.url })
        kept++
      }
    }
    let list = [...prev.values()]
    list.sort((a, b) => (b.publishedMs ?? 0) - (a.publishedMs ?? 0) || (b.fetchedAt || 0) - (a.fetchedAt || 0))
    if (list.length > MAX_PER_FEED) {
      // 淘汰的文章若仍有本地标记/待推送，一并清理本地状态（greader 的 gid 在服务端，不动 pending）
      const dropped = list.slice(MAX_PER_FEED)
      list = list.slice(0, MAX_PER_FEED)
      const state = this.stateFile.data
      for (const a of dropped) {
        delete state.read[a.id]
        delete state.starred[a.id]
      }
      await this.stateFile.save(state)
    }
    file.data = list
    await file.save(file.data)
    return { added, updated, kept }
  }

  decorate(article, feed) {
    const state = this.stateFile.data
    return {
      id: article.id,
      externalId: article.externalId,
      feedId: feed.id,
      feedTitle: feed.title,
      feedKind: feed.kind,
      group: feed.group || '',
      title: article.title,
      url: article.url,
      publishedMs: article.publishedMs,
      author: article.author,
      summaryHtml: article.summaryHtml,
      contentHtml: article.contentHtml,
      contentText: article.contentText,
      enclosureUrl: article.enclosureUrl,
      enclosureType: article.enclosureType,
      read: Boolean(state.read[article.id]),
      starred: Boolean(state.starred[article.id]),
      excerpt: textExcerpt(article.contentText || article.summaryHtml, 160),
    }
  }

  /**
   * 列表查询：单订阅/全订阅、分组（`group` 精确串，falsy=全部）、分组集合
   * （`groups` 字符串数组，按成员精确匹配；**空数组 = 显式空作用域，不匹配任何订阅**，
   * 绝不回退为「全部」；`''` 成员表示未分组桶；与 `group` 同时给出时以 `groups` 为准）、
   * 筛选（all/unread/starred）、搜索、分页。
   */
  async getArticles({ feedId, group, groups, filter = 'all', search, limit = 50, offset = 0 } = {}) {
    await this.init()
    const feeds = this.feedsFile.data.feeds
    // Array.isArray 即生效（含空数组 → 空集合 → 0 结果）；仅完全未提供时回落 legacy group
    const groupSet = Array.isArray(groups) ? new Set(groups.map((g) => String(g ?? ''))) : null
    const chosen = feeds.filter((f) =>
      (feedId ? f.id === feedId : true)
      && (groupSet ? groupSet.has(f.group || '') : (group ? (f.group || '') === group : true)))
    const rows = []
    for (const f of chosen) {
      for (const a of await this._articles(f.id)) {
        rows.push(this.decorate(a, f))
      }
    }
    rows.sort((a, b) => (b.publishedMs ?? 0) - (a.publishedMs ?? 0) || (a.id < b.id ? 1 : -1))
    let out = rows
    if (filter === 'unread') out = out.filter((a) => !a.read)
    else if (filter === 'starred') out = out.filter((a) => a.starred)
    if (search) {
      const q = String(search).toLowerCase()
      out = out.filter((a) => a.title.toLowerCase().includes(q) || (a.contentText || '').toLowerCase().includes(q))
    }
    const total = out.length
    const lim = clampInt(limit, 1, 100, 50)
    const off = clampInt(offset, 0, 100000, 0)
    return { items: out.slice(off, off + lim), total, limit: lim, offset: off }
  }

  async getArticle(id) {
    await this.init()
    for (const f of this.feedsFile.data.feeds) {
      const a = (await this._articles(f.id)).find((x) => x.id === id)
      if (a) {
        const view = this.decorate(a, f)
        view.aiResults = this.aiResultsOf(id)
        return view
      }
    }
    return null
  }

  // ---------- 已读/收藏 + FreshRSS 待推送 ----------

  /** 有界 Map 式 touch：true 重排到最新并淘汰最旧，false 移除。 */
  static _touch(map, key, value) {
    if (value) {
      delete map[key]
      map[key] = Date.now()
      const keys = Object.keys(map)
      if (keys.length > MAX_READ_IDS) delete map[keys[0]]
    } else {
      delete map[key]
    }
  }

  /** 单条标记（含待推送队列的同维度互斥入队）。article 为 decorate 后的视图。 */
  _markOne(article, patch) {
    const state = this.stateFile.data
    const enqueue = (kind, gid) => {
      for (const k of QUEUE_DIMS[kind]) {
        const q = state.pendingFresh[k]
        const i = q.findIndex((e) => e.gid === gid)
        if (i >= 0) q.splice(i, 1)
      }
      if (article.feedKind === 'greader' && gid) {
        const q = state.pendingFresh[kind]
        q.push({ gid, at: this._tick() })
        if (q.length > MAX_PENDING) q.splice(0, q.length - MAX_PENDING)
      }
    }
    if (patch.read !== undefined && Boolean(state.read[article.id]) !== Boolean(patch.read)) {
      Store._touch(state.read, article.id, Boolean(patch.read))
      if (article.feedKind === 'greader') enqueue(patch.read ? 'read' : 'unread', article.externalId)
    }
    if (patch.starred !== undefined && Boolean(state.starred[article.id]) !== Boolean(patch.starred)) {
      Store._touch(state.starred, article.id, Boolean(patch.starred))
      if (article.feedKind === 'greader') enqueue(patch.starred ? 'star' : 'unstar', article.externalId)
    }
  }

  async setMarks(id, { read, starred } = {}) {
    await this.init()
    const article = await this.getArticle(id)
    if (!article) throw new Error('文章不存在')
    this._markOne(article, { read, starred })
    await this.stateFile.save(this.stateFile.data)
    return this.pendingCounts()
  }

  /** 本地把一批文章标记已读（greader 订阅走同一条互斥入队逻辑）。作用域与 getArticles 一致。 */
  async markAllRead({ feedId, group, groups } = {}) {
    await this.init()
    let offset = 0
    let n = 0
    for (;;) {
      const page = await this.getArticles({ feedId, group, groups, filter: 'all', limit: 100, offset })
      for (const a of page.items) {
        if (!a.read) {
          this._markOne(a, { read: true })
          n++
        }
      }
      offset += page.items.length
      if (page.items.length < 100 || offset >= 1000) break
    }
    await this.stateFile.save(this.stateFile.data)
    return { marked: n }
  }

  /** 是否存在任一 greader 订阅或待推送标记（账号守卫用；须在 init 之后调用）。 */
  greaderDataExists() {
    const feeds = this.feedsFile.data ? this.feedsFile.data.feeds : []
    const p = this.stateFile.data ? this.stateFile.data.pendingFresh : null
    const pending = p ? (p.read.length + p.unread.length + p.star.length + p.unstar.length) : 0
    return feeds.some((f) => f.kind === 'greader') || pending > 0
  }

  pendingCounts() {
    const p = this.stateFile.data.pendingFresh
    return {
      read: p.read.length,
      unread: p.unread.length,
      star: p.unstar && p.star ? p.star.length : 0,
      unstar: p.unstar.length,
      total: p.read.length + p.unread.length + p.star.length + p.unstar.length,
    }
  }

  /**
   * 待推送队列快照（{gid, at} 版本化条目）。同步期间持有的快照 ack 时只删除
   * 完全相同版本的条目——同步期间产生的更新标记不会被抹掉。
   */
  pendingLists(cap = 200) {
    const p = this.stateFile.data.pendingFresh
    return {
      read: p.read.slice(0, cap),
      unread: p.unread.slice(0, cap),
      star: p.star.slice(0, cap),
      unstar: p.unstar.slice(0, cap),
    }
  }

  async ackPending(kind, entries) {
    const p = this.stateFile.data.pendingFresh
    const rm = new Set((entries || []).map((e) => `${e.gid}\u0000${e.at}`))
    p[kind] = p[kind].filter((e) => !rm.has(`${e.gid}\u0000${e.at}`))
    await this.stateFile.save(this.stateFile.data)
  }

  /**
   * FreshRSS 同步：把远端已读/加星状态落地。按维度检查待推送队列——
   * 该条目在 read/unread（或 star/unstar）维度上还有未推送的本地改动时，
   * 本地改动优先（即使是“只增”的服务端 true 也不覆盖）；没有待推送改动时，
   * 服务端的 true 与 false 都如实落地。
   * marks: [{id, gid, read, starred}]
   */
  async applyRemoteMarks(marks) {
    await this.init()
    const state = this.stateFile.data
    const p = state.pendingFresh
    const pendingRead = new Set([...p.read, ...p.unread].map((e) => e.gid))
    const pendingStar = new Set([...p.star, ...p.unstar].map((e) => e.gid))
    let changed = 0
    for (const m of marks || []) {
      if (!m || !m.id) continue
      if (!pendingRead.has(m.gid || '')) {
        if (Boolean(state.read[m.id]) !== Boolean(m.read)) {
          Store._touch(state.read, m.id, Boolean(m.read))
          changed++
        }
      }
      if (!pendingStar.has(m.gid || '')) {
        if (Boolean(state.starred[m.id]) !== Boolean(m.starred)) {
          Store._touch(state.starred, m.id, Boolean(m.starred))
          changed++
        }
      }
    }
    if (changed) await this.stateFile.save(state)
    return changed
  }

  /** FreshRSS 增量同步游标（上次同步开始时间，毫秒；null=从未增量同步过）。 */
  getGreaderCursor() {
    const v = Number(this.stateFile.data?.meta?.greaderLastSyncMs)
    return Number.isFinite(v) && v > 0 ? v : null
  }

  async setGreaderCursor(ms) {
    if (!this.stateFile.data.meta) this.stateFile.data.meta = {}
    this.stateFile.data.meta.greaderLastSyncMs = Number(ms) || Date.now()
    await this.stateFile.save(this.stateFile.data)
  }

  // ---------- AI 结果 ----------

  aiResultsOf(articleId) {
    const all = this.stateFile.data.aiResults[articleId] || []
    return all.map(({ action, model, createdAt, text }) => ({ action, model, createdAt, text }))
  }

  async saveAiResult(articleId, { action, model, text }) {
    const state = this.stateFile.data
    const list = state.aiResults[articleId] || []
    const next = list.filter((r) => r.action !== action)
    next.push({ action, model: clampStr(model, 200), createdAt: Date.now(), text: clampStr(text, 40000) })
    state.aiResults[articleId] = next
    const keys = Object.keys(state.aiResults)
    if (keys.length > MAX_AI_RESULTS) {
      const entries = keys.map((k) => [k, state.aiResults[k]]).sort((a, b) => {
        const ta = Math.max(0, ...a[1].map((r) => r.createdAt || 0))
        const tb = Math.max(0, ...b[1].map((r) => r.createdAt || 0))
        return tb - ta
      })
      for (const k of entries.slice(MAX_AI_RESULTS).map((e) => e[0])) delete state.aiResults[k]
    }
    await this.stateFile.save(state)
    return this.aiResultsOf(articleId)
  }

  // ---------- 统计 ----------

  /** 每订阅真实计数（由缓存条目与已读/收藏状态推导，非估算）：feedId -> {total, unread, starred}。 */
  async feedCounts() {
    await this.init()
    const out = {}
    for (const f of this.feedsFile.data.feeds) {
      let total = 0
      let unread = 0
      let starred = 0
      for (const a of await this._articles(f.id)) {
        total++
        if (!this.stateFile.data.read[a.id]) unread++
        if (this.stateFile.data.starred[a.id]) starred++
      }
      out[f.id] = { total, unread, starred }
    }
    return out
  }

  async stats() {
    await this.init()
    const feeds = this.feedsFile.data.feeds
    let articles = 0
    let unread = 0
    let starred = 0
    for (const f of feeds) {
      for (const a of await this._articles(f.id)) {
        articles++
        if (!this.stateFile.data.read[a.id]) unread++
        if (this.stateFile.data.starred[a.id]) starred++
      }
    }
    return {
      feeds: feeds.length,
      standalone: feeds.filter((f) => f.kind === 'standalone').length,
      greader: feeds.filter((f) => f.kind === 'greader').length,
      articles, unread, starred,
      pendingFresh: this.pendingCounts(),
      limits: STORE_LIMITS,
    }
  }

  async destroy() {
    await rm(this.dir, { recursive: true, force: true }).catch(() => {})
  }
}
