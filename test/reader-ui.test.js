import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// ---------- 阅读工作台回归：分组导航 / 作用域查询 / 计数 / 过期守卫 / 分页 / 响应式 ----------
//
// 复用 client.test.js 的最小 React hooks 运行时思路（createElement + useState/useEffect/useRef），
// 面向重设计后的三栏工作台做行为级回归。宿主 fetch 用内存路由模拟，articles 路由按
// body.groups / body.feedId / body.filter / body.search / body.offset 真实过滤，确保
// 「选中分组/未分组/单订阅 → 列表确实按该作用域查询」被验证，而不是只看请求发出。

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')

function createHarness(opts = {}) {
  const fetchLog = []
  const routes = {}
  const confirms = []
  const respond = (path, fn) => { routes[path] = fn }
  const pathOf = (url) => String(url).replace(/^https?:\/\/[^/]+/, '')
  const sandboxFetch = async (url, opts = {}) => {
    const method = opts.method || 'GET'
    const body = opts.body ? JSON.parse(opts.body) : null
    fetchLog.push({ path: pathOf(url), method, body, headers: opts.headers || {} })
    const out = routes[pathOf(url)] ? routes[pathOf(url)](body, method) : { ok: true }
    return { json: async () => out }
  }

  const hookValues = []
  const hookRefs = []
  let hookIdx = 0
  const effectPrev = []
  const pendingEffects = []
  let component = null
  let tree = null
  let rerenderScheduled = false

  let renderProps = {}
  const rerender = () => {
    if (!component) return
    hookIdx = 0
    tree = component(renderProps)
    const list = pendingEffects.splice(0)
    for (const fn of list) fn()
  }

  const ReactLike = {
    createElement(tag, props, ...children) {
      return { tag, props: props || {}, children }
    },
    useState(init) {
      const i = hookIdx++
      if (i >= hookValues.length) hookValues[i] = typeof init === 'function' ? init() : init
      const setter = (v) => {
        const next = typeof v === 'function' ? v(hookValues[i]) : v
        if (!Object.is(next, hookValues[i])) {
          hookValues[i] = next
          if (!rerenderScheduled) {
            rerenderScheduled = true
            queueMicrotask(() => { rerenderScheduled = false; rerender() })
          }
        }
      }
      return [hookValues[i], setter]
    },
    useRef(init) {
      if (!hookRefs[hookIdx]) hookRefs[hookIdx] = { current: typeof init === 'function' ? init() : init }
      return hookRefs[hookIdx++]
    },
    useEffect(fn, deps) {
      const i = hookIdx++
      const prev = effectPrev[i]
      const changed = !prev || !deps || deps.length !== prev.length || deps.some((d, j) => !Object.is(d, prev[j]))
      if (changed) {
        effectPrev[i] = deps
        pendingEffects.push(fn)
      }
    },
  }

  const tick = (ms = 14) => new Promise((r) => setTimeout(r, ms))

  const loadApp = (props = {}) => {
    renderProps = props
    const loads = []
    // localStorage mock：可跨 harness 共享（simulate 面板卸载重挂/进程重启后的恢复）；
    // setInterval 有意不提供——自动刷新的 interval 路径须自身守卫，且避免测试进程挂定时器。
    const lsBacking = opts.storage || {}
    const lsMock = {
      getItem: (k) => Object.prototype.hasOwnProperty.call(lsBacking, k) ? lsBacking[k] : null,
      setItem: (k, v) => { lsBacking[k] = String(v) },
      removeItem: (k) => { delete lsBacking[k] },
    }
    const sandbox = {
      window: {
        __ModuleLoader__: { load: (s) => loads.push(s) },
        confirm: (msg) => { confirms.push(msg); return true },
        prompt: () => null,
      },
      fetch: sandboxFetch,
      FileReader: class { readAsText(file) { queueMicrotask(() => { this.result = file.text; this.onload() }) } },
      Blob: class {},
      URL,
      setTimeout,
      clearTimeout,
      console,
      localStorage: lsMock,
      navigator: opts.navigator || {},
    }
    vm.createContext(sandbox)
    vm.runInContext(src, sandbox, { filename: 'client.js' })
    const mod = loads[0].factory((n) => (n === 'react' ? ReactLike : null))
    component = mod._App
    hookIdx = 0
    tree = component(renderProps)
    const list = pendingEffects.splice(0)
    for (const fn of list) fn()
    return mod
  }

  const flatten = (node, out = []) => {
    if (Array.isArray(node)) { node.forEach((n) => flatten(n, out)); return out }
    if (node && typeof node === 'object') {
      out.push(node)
      flatten(node.children || [], out)
    }
    return out
  }
  const nodesWithText = (text) => flatten(tree).filter((n) => {
    const kids = (n.children || []).filter((c) => typeof c === 'string')
    return kids.some((c) => String(c).includes(text))
  })
  const subtreeText = (node) => {
    let s = ''
    const walk = (x) => {
      if (Array.isArray(x)) { x.forEach(walk); return }
      if (typeof x === 'string') { s += x; return }
      if (x && typeof x === 'object') walk(x.children || [])
    }
    walk(node)
    return s
  }
  const click = (text) => {
    const clickable = flatten(tree).filter((n) => typeof n.props.onClick === 'function' && subtreeText(n).includes(text))
    // 精确文本优先：如「未读」筛选 pill 不被「只看未读」开关截胡
    const node = clickable.find((n) => subtreeText(n) === text) || clickable[0]
    assert.ok(node, `找不到可点击的“${text}”`)
    node.props.onClick({ stopPropagation: () => {}, target: { value: '' }, key: 'Enter' })
  }
  /** 精确点击分组导航行（按行内 label 文本），避免误点文章 meta 里的分组名。 */
  const clickNav = (label) => {
    const node = flatten(tree).find((n) =>
      (n.props.className || '').includes('drss-nav-row')
      && (n.children || []).some((c) => c && c.props && c.props.className === 'drss-nav-label' && c.children && c.children[0] === label))
    assert.ok(node, `找不到分组导航行“${label}”`)
    node.props.onClick({ stopPropagation: () => {} })
  }
  /** 点击分组折叠钮（按 aria-label 定位；其可见文本只是 ▸/▾）。
   *  aria-label 形如「展开分组 技术」/「收起分组 技术」；不带参数时点第一个仍折叠的分组。 */
  const chevOf = (label) => flatten(tree).find((n) =>
    typeof n.props.onClick === 'function' && typeof n.props['aria-label'] === 'string'
    && (label
      ? n.props['aria-label'] === `展开分组 ${label}` || n.props['aria-label'] === `收起分组 ${label}`
      : n.props['aria-label'].indexOf('展开分组 ') === 0))
  const clickChev = (label) => {
    const node = chevOf(label)
    assert.ok(node, `找不到折叠钮“${label ? `展开分组 ${label}` : '展开分组'}”`)
    node.props.onClick({ stopPropagation: () => {} })
    return node
  }
  /** 键盘操作折叠钮（Space/Enter）：返回是否 preventDefault（默认滚动必须被阻止）。 */
  const pressChevKey = (label, key = ' ') => {
    const node = chevOf(label)
    assert.ok(node, `找不到折叠钮“${label}”`)
    let prevented = false
    assert.equal(typeof node.props.onKeyDown, 'function', '折叠钮应有 onKeyDown')
    node.props.onKeyDown({ key, preventDefault: () => { prevented = true } })
    return prevented
  }
  /** 某导航行（全部文章/分组/未分组/订阅）的未读徽标数值；无徽标视为 0。 */
  const navCountOf = (label) => {
    const row = flatten(tree).find((n) => (n.props.className || '').includes('drss-nav-row') && (n.children || []).some((c) => c && c.props && c.props.className === 'drss-nav-label' && c.children && c.children[0] === label))
    if (!row) return null
    const badge = (row.children || []).find((c) => c && c.props && (c.props.className || '').startsWith('drss-nav-count'))
    return badge ? Number(String(badge.children[0]).split('/')[0]) : 0
  }
  /** 精确点击文章列表行（按 .drss-item 的标题匹配；避免与「全部文章N」徽标等文本误配）。 */
  const clickArticle = (title) => {
    const node = flatten(tree).find((n) =>
      (n.props.className || '').includes('drss-item') && typeof n.props.onClick === 'function'
      && (n.children || []).some((c) => c && c.props && c.props.className === 'drss-item-title' && c.children && c.children[0] === title))
    assert.ok(node, `找不到文章行“${title}”`)
    node.props.onClick({ stopPropagation: () => {}, target: { value: '' } })
  }
  /** 分组栏整体文本（只看导航栏，不受文章 meta 干扰）。 */
  const foldersText = () => {
    const pane = flatten(tree).find((n) => n.props.className === 'drss-folders')
    return pane ? subtreeText(pane) : ''
  }
  const articleBodies = () => fetchLog.filter((f) => f.path === '/dsh-rss/articles').map((f) => f.body)
  const titles = () => flatten(tree).filter((n) => (n.props.className || '').includes('drss-item-title')).map((n) => subtreeText(n))

  const showAll = async () => {
    const b = flatten(tree).find((n) => (n.props.className || '').includes('drss-hide-done') && typeof n.props.onClick === 'function')
    assert.ok(b, '找不到「只看未读」开关')
    b.props.onClick({})
    await tick()
  }
  return { respond, fetchLog, confirms, loadApp, tick, tree: () => tree, nodesWithText, click, clickArticle, clickNav, clickChev, chevOf, pressChevKey, navCountOf, foldersText, articleBodies, titles, flatten, subtreeText, showAll }
}

// ---------- 夹具：真实分组的订阅 + 文章 + 真实计数 ----------

const FEEDS = [
  { id: 'fa', kind: 'standalone', url: 'https://a.example/feed', title: '甲站', group: '技术/前端' },
  { id: 'fb', kind: 'standalone', url: 'https://b.example/feed', title: '乙站', group: '技术/后端' },
  { id: 'fc', kind: 'standalone', url: 'https://c.example/feed', title: '丙站', group: '生活' },
  { id: 'fd', kind: 'standalone', url: 'https://d.example/feed', title: '丁站', group: '' },
]
const COUNTS = { fa: { total: 5, unread: 2, starred: 0 }, fb: { total: 4, unread: 1, starred: 0 }, fc: { total: 3, unread: 0, starred: 1 }, fd: { total: 2, unread: 3, starred: 0 } }
const STATS = { articles: 14, unread: 6, starred: 1, pendingFresh: { total: 0 }, feeds: 4 }

function makeArticle(n, feedId, over = {}) {
  const f = FEEDS.find((x) => x.id === feedId)
  return {
    id: `art-${n}`, feedId, feedTitle: f.title, feedKind: 'standalone', group: f.group,
    title: `文章${n}`, url: `https://example.com/${n}`, publishedMs: 1760000000000 + n, author: null,
    summaryHtml: '<p>摘要</p>', contentHtml: `<p>正文${n}</p>`, contentText: `正文${n}`,
    read: false, starred: false, excerpt: '', aiResults: [], ...over,
  }
}
const ARTICLES = [
  makeArticle(1, 'fa'), makeArticle(2, 'fa', { read: true }), makeArticle(3, 'fb'),
  makeArticle(4, 'fc', { starred: true }), makeArticle(5, 'fd'), makeArticle(6, 'fd'),
]

/** 内存版 articles 路由：按作用域真实过滤（与 host 语义一致），支持分页。 */
function articleRouter(all) {
  return (body) => {
    let rows = all
    if (body && body.feedId) rows = rows.filter((a) => a.feedId === body.feedId)
    if (body && Array.isArray(body.groups)) {
      const set = new Set(body.groups)
      rows = rows.filter((a) => set.has(a.group || ''))
    }
    if (body && body.filter === 'unread') rows = rows.filter((a) => !a.read)
    if (body && body.filter === 'starred') rows = rows.filter((a) => a.starred)
    if (body && body.search) {
      const q = String(body.search).toLowerCase()
      rows = rows.filter((a) => a.title.toLowerCase().includes(q) || (a.contentText || '').toLowerCase().includes(q))
    }
    rows = [...rows].sort((a, b) => b.publishedMs - a.publishedMs)
    const limit = (body && body.limit) || 50
    const offset = (body && body.offset) || 0
    return { ok: true, items: rows.slice(offset, offset + limit), total: rows.length, limit, offset }
  }
}

function primeCommon(t) {
  t.respond('/dsh-rss/config', () => ({ ok: true, config: {}, stats: STATS }))
  t.respond('/dsh-rss/feeds/list', () => ({ ok: true, feeds: FEEDS.map((f) => ({ ...f })), counts: COUNTS, stats: STATS }))
  t.respond('/dsh-rss/article', (body) => {
    const a = ARTICLES.find((x) => x.id === body.id)
    return { ok: true, article: a }
  })
  t.respond('/dsh-rss/mark', () => ({ ok: true }))
  t.respond('/dsh-rss/feeds/mark-all-read', () => ({ ok: true, marked: 2, pending: { total: 0 } }))
}

const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

test('分组导航：按实际分组渲染树、未分组单列、计数为 host 真实值', async () => {
  const t = createHarness()
  primeCommon(t)
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t.loadApp()
  await t.tick()
  // 默认「只看未读」：全已读的「生活/丙站」隐藏；本测试验证完整树 → 先切显示全部
  await t.showAll()
  // 顶级分组：技术（有子分组 → 默认折叠）、生活（叶子 → 默认展开）；未分组独立一行
  // 断言只看分组栏文本（文章 meta 也含分组路径，不能用作分组栏证据）
  const folders = t.foldersText()
  assert.ok(folders.includes('技术'), '顶级分组「技术」应显示')
  assert.ok(folders.includes('生活'), '叶子分组「生活」应显示')
  assert.ok(folders.includes('未分组'), '「未分组」桶应显示')
  assert.ok(!folders.includes('前端'), '有子分组的「技术」默认折叠，不显示子分组')
  assert.ok(!folders.includes('甲站'), '折叠的分组下订阅行不渲染')
  // 展开「技术」：子分组与订阅出现
  t.clickChev() // 第一个折叠分组（技术）的折叠钮
  await t.tick()
  const folders2 = t.foldersText()
  assert.ok(folders2.includes('前端') && folders2.includes('后端'), '展开后显示子分组')
  assert.ok(folders2.includes('甲站') && folders2.includes('乙站'), '展开后显示分组内订阅')
  // 真实计数（未读/总数双计数）：全部=6/14、技术=3/9、未分组=3/2；从 feeds/list 的 counts 汇总，非编造
  const counts = t.flatten(t.tree()).filter((n) => (n.props.className || '').startsWith('drss-nav-count')).map((n) => String(n.children[0]))
  assert.ok(counts.includes('6/14'), `「全部」应为 未读6/总数14：${counts.join(',')}`)
  assert.ok(counts.includes('3/9'), `「技术」应为 未读3/总数9：${counts.join(',')}`)
})

test('作用域查询：分组=子树分组串、未分组=空串桶、单订阅=feedId、全部=无作用域参数', async () => {
  const t = createHarness()
  primeCommon(t)
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t.loadApp()
  await t.tick()
  // 默认全部：无 groups/feedId
  assert.ok(!t.articleBodies()[0].groups && !t.articleBodies()[0].feedId)

  t.clickNav('技术') // 顶级分组（含子树）
  await t.tick()
  const groupBody = t.articleBodies().at(-1)
  assert.deepEqual([...groupBody.groups].sort(), ['技术/前端', '技术/后端'], '分组选择应展开为实际存在的子树分组串')
  assert.deepEqual(t.titles().sort(), ['文章1', '文章2', '文章3'], '列表确实只含该子树的文章')

  t.clickChev() // 展开「技术」
  await t.tick()
  t.clickNav('前端') // 子分组
  await t.tick()
  assert.deepEqual(t.articleBodies().at(-1).groups, ['技术/前端'])
  assert.deepEqual(t.titles().sort(), ['文章1', '文章2'], '子分组只含自己的文章')

  t.clickNav('未分组')
  await t.tick()
  assert.deepEqual(t.articleBodies().at(-1).groups, [''], '未分组桶显式传空串分组')
  assert.deepEqual(t.titles().sort(), ['文章5', '文章6'])

  t.clickNav('丁站')
  await t.tick()
  const feedBody = t.articleBodies().at(-1)
  assert.equal(feedBody.feedId, 'fd')
  assert.ok(!feedBody.groups, '单订阅不应带 groups')
})

test('批量已读严格按作用域下发（分组/未分组/单订阅），确认框说明作用域', async () => {
  const t = createHarness()
  primeCommon(t)
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t.loadApp()
  await t.tick()

  t.clickNav('技术')
  await t.tick()
  t.click('全部已读')
  await t.tick()
  const groupMark = t.fetchLog.filter((f) => f.path === '/dsh-rss/feeds/mark-all-read').at(-1).body
  assert.deepEqual([...groupMark.groups].sort(), ['技术/前端', '技术/后端'], '分组全部已读只下发该子树分组')
  assert.ok(t.confirms.at(-1).includes('分组「技术」'), '确认框应说明作用域')
  assert.ok(t.nodesWithText('已将分组「技术」标记 2 篇为已读').length, '完成消息应说明作用域')

  t.clickNav('未分组')
  await t.tick()
  t.click('全部已读')
  await t.tick()
  assert.deepEqual(t.fetchLog.filter((f) => f.path === '/dsh-rss/feeds/mark-all-read').at(-1).body.groups, [''])

  t.clickNav('丁站')
  await t.tick()
  t.click('全部已读')
  await t.tick()
  const feedMark = t.fetchLog.filter((f) => f.path === '/dsh-rss/feeds/mark-all-read').at(-1).body
  assert.equal(feedMark.feedId, 'fd')
  assert.ok(!feedMark.groups)
})

test('真实未读计数：打开未读文章后本地递减，星标/已读切换同步', async () => {
  const t = createHarness()
  primeCommon(t)
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t.loadApp()
  await t.tick()
  const countOf = (label) => {
    const row = t.flatten(t.tree()).find((n) => (n.props.className || '').includes('drss-nav-row') && ((n.children || []).some((c) => c && c.props && c.props.className === "drss-nav-label" && c.children && c.children[0] === label)))
    const badge = (row.children || []).find((c) => c && c.props && (c.props.className || '').startsWith('drss-nav-count'))
    return badge ? Number(String(badge.children[0]).split('/')[0]) : 0
  }
  t.clickChev() // 展开「技术」，让订阅行（甲站/乙站）可寻址
  await t.tick()
  assert.equal(countOf('技术'), 3, '分组计数=成员订阅之和（甲2+乙1）')

  t.click('文章1') // 甲站未读文章 → 自动标已读
  await t.tick()
  assert.equal(countOf('技术'), 2, '打开未读文章后分组未读递减')
  assert.equal(countOf('甲站'), 1, '订阅未读递减')

  t.click('标为未读')
  await t.tick()
  assert.equal(countOf('技术'), 3, '标为未读恢复计数')
})

test('过期响应守卫：作用域切换后，旧请求的迟到响应不落地', async () => {
  const t = createHarness()
  primeCommon(t)
  let resolveAll
  const deferredAll = new Promise((r) => { resolveAll = r })
  t.respond('/dsh-rss/articles', (body) => {
    if (Array.isArray(body.groups)) return articleRouter(ARTICLES)(body) // 新作用域立即响应
    return deferredAll // 旧「全部」请求挂起
  })
  t.loadApp()
  await t.tick(5)
  t.clickNav('未分组') // 切换作用域（新请求立即返回）
  await t.tick()
  resolveAll({ ok: true, items: [makeArticle(9, 'fa')], total: 1 }) // 旧响应迟到，带无关文章
  await t.tick()
  assert.ok(!t.titles().includes('文章9'), '迟到的不属于当前作用域的响应应被丢弃')
  assert.deepEqual(t.titles().sort(), ['文章5', '文章6'])
})

test('分页：30 条一页 + 加载更多按 offset 递进，替代无解释的 50 条截断', async () => {
  const t = createHarness()
  primeCommon(t)
  const many = []
  for (let i = 1; i <= 45; i++) many.push(makeArticle(i, i <= 22 ? 'fa' : 'fb'))
  t.respond('/dsh-rss/articles', articleRouter(many))
  t.loadApp()
  await t.tick()
  assert.equal(t.titles().length, 30, '首页 30 条')
  assert.ok(t.flatten(t.tree()).some((n) => t.subtreeText(n).includes('已显示 30 / 45')), '应展示进度说明')
  t.click('加载更多')
  await t.tick()
  const offsets = t.articleBodies().map((b) => b.offset)
  assert.deepEqual(offsets, [0, 30], '加载更多按 offset 递进')
  assert.equal(t.titles().length, 45)
  assert.ok(t.flatten(t.tree()).some((n) => t.subtreeText(n).includes('已显示全部 45 篇')), '加载完显示完成态')
})

test('筛选与搜索沿用当前作用域；切换分组重置文章选择', async () => {
  const t = createHarness()
  primeCommon(t)
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t.loadApp()
  await t.tick()
  t.click('未读')
  await t.tick()
  const unreadBody = t.articleBodies().at(-1)
  assert.equal(unreadBody.filter, 'unread')
  assert.ok(!unreadBody.groups, '全部作用域下筛选不带分组')

  t.clickNav('技术')
  await t.tick()
  const scopedUnread = t.articleBodies().at(-1)
  assert.equal(scopedUnread.filter, 'unread', '筛选状态跨作用域保留')
  assert.deepEqual([...scopedUnread.groups].sort(), ['技术/前端', '技术/后端'], '搜索/筛选都在作用域内执行')

  const searchInput = t.flatten(t.tree()).find((n) => n.tag === 'input' && (n.props.placeholder || '').includes('搜索标题与正文'))
  searchInput.props.onChange({ target: { value: '正文3' } })
  await t.tick(300)
  const searched = t.articleBodies().at(-1)
  assert.equal(searched.search, '正文3', '搜索词随请求下发')
  assert.equal(searched.filter, 'unread')
  assert.deepEqual(t.titles(), ['文章3'], '搜索结果在作用域+筛选内')

  // 打开文章后切换分组：文章视图让位（data-art 归零），不显示旧文章
  t.click('文章3')
  await t.tick()
  assert.equal(t.tree().props['data-art'], '1', '打开文章时窄容器切到阅读态')
  t.clickNav('未分组')
  await t.tick()
  assert.equal(t.tree().props['data-art'], '0', '切换作用域应关闭旧文章')
})

test('窄容器响应式结构：抽屉开关与阅读态由根节点数据属性驱动', async () => {
  const t = createHarness()
  primeCommon(t)
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t.loadApp()
  await t.tick()
  assert.equal(t.tree().props['data-folders'], 'closed')
  t.click('☰ 订阅')
  await t.tick()
  assert.equal(t.tree().props['data-folders'], 'open', '☰ 订阅应打开分组抽屉')
  t.click('☰ 订阅')
  await t.tick()
  assert.equal(t.tree().props['data-folders'], 'closed')
  // 三栏结构存在（分组栏/列表/阅读栏），CSS 容器查询负责窄容器折叠（源码级断言）
  const css = src
  assert.ok(css.includes('container-type:inline-size') && css.includes('@container (max-width: 920px)'), '样式应含容器查询窄容器适配')
  assert.ok(css.includes('.drss-folders') && css.includes('.drss-list') && css.includes('.drss-read'), '三栏类名齐备')
})

// ---------- 七项评审缺陷的回归 ----------

test('缺陷3：叶子分组默认展开、首次点击即收起；折叠钮与选择钮为同级真实按钮（aria-expanded/Space 阻止默认）', async () => {
  const t = createHarness()
  primeCommon(t)
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t.loadApp()
  await t.tick()
  await t.showAll() // 「生活/丙站」全已读，默认被「只看未读」隐藏；本测试验证完整树
  // 叶子分组「生活」默认展开：订阅行可见；折叠钮呈「收起」态
  assert.ok(t.foldersText().includes('丙站'), '叶子分组默认展开，订阅行可见')
  const chev = t.chevOf('生活')
  assert.ok(chev, '展开态折叠钮应有「收起分组 生活」aria-label')
  assert.equal(chev.tag, 'button', '折叠钮是真实 button（可聚焦）')
  assert.equal(chev.props['aria-expanded'], 'true')
  assert.equal(chev.props.type, 'button')
  // 折叠钮与选择钮是同级兄弟按钮（同一个 .drss-nav-item 内恰好两个 button）
  const item = t.flatten(t.tree()).find((n) => n.props.className === 'drss-nav-item' && t.subtreeText(n).includes('生活'))
  assert.ok(item, '分组行容器 .drss-nav-item 应存在')
  const btns = (item.children || []).filter((c) => c && c.tag === 'button')
  assert.equal(btns.length, 2, '同级两个真实按钮：折叠钮 + 选择钮')
  assert.ok(btns.some((b) => (b.props.className || '').includes('drss-nav-chev')))
  assert.ok(btns.some((b) => (b.props.className || '').includes('drss-nav-row')))
  // 首次点击折叠钮：默认展开的叶子立即收起（针对「当前有效值」切换）
  const queriesBefore = t.articleBodies().length
  t.clickChev('生活')
  await t.tick()
  assert.ok(!t.foldersText().includes('丙站'), '首次点击应收起默认展开的叶子分组')
  assert.equal(t.chevOf('生活').props['aria-expanded'], 'false', '收起后 aria-expanded=false')
  assert.equal(t.chevOf('生活').props['aria-label'], '展开分组 生活')
  assert.equal(t.articleBodies().length, queriesBefore, '折叠/展开不应触发作用域查询')
  // Space 键：阻止默认（滚动）并切换展开态；Enter 同理；都不选中分组
  assert.ok(t.pressChevKey('生活', ' '), 'Space 应 preventDefault')
  await t.tick()
  assert.ok(t.foldersText().includes('丙站'), 'Space 应切换展开态')
  assert.equal(t.articleBodies().length, queriesBefore, '键盘切换同样不触发作用域查询')
  assert.ok(t.pressChevKey('生活', 'Enter'), 'Enter 应 preventDefault')
  await t.tick()
  assert.ok(!t.foldersText().includes('丙站'))
  // 有子分组的「技术」默认折叠：首次点击展开（另一半语义）
  t.clickChev('技术')
  await t.tick()
  assert.ok(t.foldersText().includes('前端'), '折叠分组首次点击应展开')
})

test('缺陷2：规范化导航路径映射到原始分组串；纯空白分组归入未分组桶', async () => {
  const t = createHarness()
  const FEEDS2 = [
    { id: 'fa', kind: 'standalone', url: 'https://a.example/feed', title: '甲站', group: ' 技术 / 前端 ' },
    { id: 'fb', kind: 'standalone', url: 'https://b.example/feed', title: '乙站', group: '技术/前端' },
    { id: 'fw', kind: 'standalone', url: 'https://w.example/feed', title: '戊站', group: '   ' },
    { id: 'fd', kind: 'standalone', url: 'https://d.example/feed', title: '丁站', group: '' },
  ]
  const art = (n, feedId) => {
    const f = FEEDS2.find((x) => x.id === feedId)
    return { id: `art-${n}`, feedId, feedTitle: f.title, feedKind: 'standalone', group: f.group, title: `文章${n}`, url: `https://e/${n}`, publishedMs: 1760000000000 + n, author: null, summaryHtml: '', contentHtml: `<p>正文${n}</p>`, contentText: `正文${n}`, read: false, starred: false, excerpt: '', aiResults: [] }
  }
  const ART2 = [art(1, 'fa'), art(2, 'fb'), art(5, 'fw'), art(6, 'fd')]
  t.respond('/dsh-rss/config', () => ({ ok: true, config: {}, stats: {} }))
  t.respond('/dsh-rss/feeds/list', () => ({ ok: true, feeds: FEEDS2.map((f) => ({ ...f })), counts: {}, stats: {} }))
  t.respond('/dsh-rss/article', (b) => ({ ok: true, article: ART2.find((x) => x.id === b.id) }))
  t.respond('/dsh-rss/mark', () => ({ ok: true }))
  t.respond('/dsh-rss/feeds/mark-all-read', () => ({ ok: true, marked: 0, pending: { total: 0 } }))
  t.respond('/dsh-rss/articles', articleRouter(ART2))
  t.loadApp()
  await t.tick()
  // 「 技术 / 前端 」与「技术/前端」规范化后是同一节点（有子分组 → 默认折叠）；
  // 纯空白「   」不进分组树，归入未分组桶
  const folders = t.foldersText()
  assert.ok(folders.includes('技术'), '规范化后的顶级分组应显示')
  assert.ok(!folders.includes('前端'), '有子分组的「技术」默认折叠')
  assert.ok(folders.includes('未分组') && folders.includes('戊站') && folders.includes('丁站'), '纯空白分组与空串都在未分组桶')
  // 选中「技术」：请求下发的是该子树**实际存在的原始分组串**（含空白填充的原文）
  t.clickNav('技术')
  await t.tick()
  assert.deepEqual([...t.articleBodies().at(-1).groups].sort(), [' 技术 / 前端 ', '技术/前端'], '子树展开为原始分组串（host 按原文精确匹配）')
  assert.deepEqual(t.titles().sort(), ['文章1', '文章2'])
  // 子分组「前端」同样映射两条原始串
  t.clickChev('技术')
  await t.tick()
  t.clickNav('前端')
  await t.tick()
  assert.deepEqual([...t.articleBodies().at(-1).groups].sort(), [' 技术 / 前端 ', '技术/前端'])
  // 未分组桶：显式下发空串 + 纯空白原始串
  t.clickNav('未分组')
  await t.tick()
  assert.deepEqual([...t.articleBodies().at(-1).groups].sort(), ['', '   '], '未分组=规范化为空的全部原始串')
  assert.deepEqual(t.titles().sort(), ['文章5', '文章6'])
})

test('缺陷1：选中分组消失后，查询与批量已读都是显式空作用域（0 结果 0 写入），绝不回落全部', async () => {
  const t = createHarness()
  let feedsNow = FEEDS.map((f) => ({ ...f }))
  t.respond('/dsh-rss/config', () => ({ ok: true, config: {}, stats: STATS }))
  t.respond('/dsh-rss/feeds/list', () => ({ ok: true, feeds: feedsNow.map((f) => ({ ...f })), counts: COUNTS, stats: STATS }))
  t.respond('/dsh-rss/article', (b) => ({ ok: true, article: ARTICLES.find((x) => x.id === b.id) }))
  t.respond('/dsh-rss/mark', () => ({ ok: true }))
  t.respond('/dsh-rss/feeds/mark-all-read', () => ({ ok: true, marked: 0, pending: { total: 0 } }))
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t.respond('/dsh-rss/refresh', () => ({ ok: true, results: [{ feedId: 'fa', title: '甲站', ok: true, added: 0, updated: 0, kept: 2 }] }))
  t.loadApp()
  await t.tick()
  t.clickNav('技术')
  await t.tick()
  assert.deepEqual([...t.articleBodies().at(-1).groups].sort(), ['技术/前端', '技术/后端'])
  assert.equal(t.titles().length, 3)
  // 场景：其他入口把「技术」子树全部改组 → feeds/list 不再有任何该分组订阅（选中分组“消失”）
  feedsNow = feedsNow.map((f) => (f.id === 'fa' || f.id === 'fb' ? { ...f, group: '别的' } : f))
  t.click('⟳ 刷新')
  await t.tick()
  assert.ok(!t.foldersText().includes('技术'), '分组消失后导航树不再渲染该分组')
  assert.ok(t.foldersText().includes('别的'), '新分组按实际数据出现')
  // 作用域仍是 group:技术，但已无成员 → 查询显式 groups:[]（空列表，不是全部文章）
  t.click('未读')
  await t.tick()
  const lastQuery = t.articleBodies().at(-1)
  assert.deepEqual(lastQuery.groups, [], '消失分组的作用域必须显式空数组（0 匹配），绝不回落全部')
  assert.deepEqual(t.titles(), [], '列表应为空')
  assert.ok(t.nodesWithText('当前范围内暂无文章').length, '应显示空态而非全部文章')
  // 批量已读同样只下发 groups:[]（host 侧 0 写入，见 host/store 测试）
  t.click('全部已读')
  await t.tick()
  assert.deepEqual(t.fetchLog.filter((f) => f.path === '/dsh-rss/feeds/mark-all-read').at(-1).body.groups, [], '批量已读显式空作用域')
  assert.ok(t.confirms.at(-1).includes('分组「技术」'), '确认框仍如实说明作用域')
})

test('缺陷4：作用域切换后，A 的旧文章/mark/AI 响应一律不落地；mark 完成的刷新用最新查询', async () => {
  const t = createHarness()
  primeCommon(t)
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  let resolveArticle = null
  let deferArticle = true
  t.respond('/dsh-rss/article', (b) => {
    if (deferArticle) { deferArticle = false; return new Promise((r) => { resolveArticle = r }) } // 首次打开挂起；此后立即返回
    return { ok: true, article: ARTICLES.find((x) => x.id === b.id) }
  })
  let resolveMark = null
  t.respond('/dsh-rss/mark', () => new Promise((r) => { resolveMark = r }))
  t.loadApp()
  await t.tick()
  // A 的文章响应挂起期间切换作用域：迟到响应不得把 A 写回阅读栏
  t.clickArticle('文章1')
  t.clickNav('未分组')
  await t.tick()
  resolveArticle({ ok: true, article: ARTICLES[0] })
  await t.tick()
  assert.equal(t.tree().props['data-art'], '0', '旧文章的迟到响应不得复活阅读态')
  assert.ok(t.nodesWithText('从列表选择一篇文章开始阅读').length)
  // A 的 mark 完成于切换之后：刷新必须用最新作用域+筛选，且不恢复 A
  t.click('未读')
  await t.tick()
  t.clickArticle('文章5') // 未分组下的未读文章（fd）→ 自动已读挂起
  await t.tick()
  const articleCalls = t.fetchLog.filter((f) => f.path === '/dsh-rss/article').length
  t.clickNav('技术') // 期间切到 B
  await t.tick()
  resolveMark({ ok: true })
  await t.tick()
  const last = t.articleBodies().at(-1)
  assert.deepEqual([...last.groups].sort(), ['技术/前端', '技术/后端'], 'mark 完成后的刷新用最新作用域')
  assert.equal(last.filter, 'unread', 'mark 完成后的刷新沿用最新筛选')
  assert.equal(t.tree().props['data-art'], '0', 'mark 完成不得恢复旧选中文章')
  assert.equal(t.fetchLog.filter((f) => f.path === '/dsh-rss/article').length, articleCalls, '不应重新拉取文章')
})

test('缺陷4：AI 结果迟到处境——原文已切换时不落地当前视图，只提示已保存', async () => {
  const t = createHarness()
  t.respond('/dsh-rss/config', () => ({ ok: true, config: { ai: { configured: true, enabled: true } }, stats: STATS }))
  t.respond('/dsh-rss/feeds/list', () => ({ ok: true, feeds: FEEDS.map((f) => ({ ...f })), counts: COUNTS, stats: STATS }))
  t.respond('/dsh-rss/article', (b) => ({ ok: true, article: ARTICLES.find((x) => x.id === b.id) }))
  t.respond('/dsh-rss/mark', () => ({ ok: true }))
  t.respond('/dsh-rss/feeds/mark-all-read', () => ({ ok: true, marked: 0, pending: { total: 0 } }))
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  let resolveAi = null
  t.respond('/dsh-rss/ai/action', () => new Promise((r) => { resolveAi = r }))
  t.loadApp()
  await t.tick()
  t.clickArticle('文章1')
  await t.tick()
  t.click('✨ AI 摘要')
  await t.tick(5)
  t.clickNav('未分组') // AI 在途时切换作用域（选中文章关闭）
  await t.tick()
  resolveAi({ ok: true, action: 'summary', model: 'test-model', text: '旧文章的AI摘要' })
  await t.tick()
  assert.ok(t.nodesWithText('原文已切换，结果已保存').length, '应如实提示结果未落地当前视图')
  assert.equal(t.nodesWithText('旧文章的AI摘要').length, 0, '旧文章的 AI 结果不得渲染')
  // 之后打开别的文章：结果同样不得串到新视图
  t.clickArticle('文章5')
  await t.tick()
  assert.equal(t.nodesWithText('旧文章的AI摘要').length, 0)
})

test('缺陷4：筛选/搜索变化立即作废在途请求（含防抖窗口内的迟到响应）', async () => {
  const t = createHarness()
  primeCommon(t)
  let resolveSlow = null
  const slow = () => new Promise((r) => { resolveSlow = r })
  t.respond('/dsh-rss/articles', (body) => {
    if (!body.search && body.filter === 'all' && !Array.isArray(body.groups)) return slow() // 初始请求挂起
    if (body.search === '正文') return slow() // 旧搜索词的慢响应
    return articleRouter(ARTICLES)(body)
  })
  t.loadApp()
  await t.tick(5)
  // 筛选切换：立即作废挂起的初始请求
  t.click('未读')
  await t.tick()
  resolveSlow({ ok: true, items: [makeArticle(9, 'fa')], total: 1 })
  await t.tick()
  assert.ok(!t.titles().includes('文章9'), '筛选切换后旧请求的迟到响应应丢弃')
  assert.deepEqual(t.titles().sort(), ['文章1', '文章3', '文章4', '文章5', '文章6'])
  // 搜索防抖：'正文' 的慢响应在继续输入 '3' 后到达 → 丢弃；'正文3' 正常落地
  const searchInput = t.flatten(t.tree()).find((n) => n.tag === 'input' && (n.props.placeholder || '').includes('搜索标题与正文'))
  searchInput.props.onChange({ target: { value: '正文' } })
  await t.tick(300) // '正文' 请求已发出（挂起）
  searchInput.props.onChange({ target: { value: '正文3' } }) // 继续输入：立即作废 + 重新防抖
  resolveSlow({ ok: true, items: [makeArticle(9, 'fa')], total: 1 })
  await t.tick(300)
  assert.ok(!t.titles().includes('文章9'), '防抖窗口内被作废的旧搜索响应不得落地')
  assert.deepEqual(t.titles(), ['文章3'], '新搜索词的结果正常显示')
})

test('缺陷5：计数只在写确认后更新——失败保留计数并报错；并发减计数不丢；根计数与分组一致', async () => {
  // (a) 单条自动已读失败：计数不动 + 错误可见
  const a = createHarness()
  primeCommon(a)
  a.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  a.respond('/dsh-rss/mark', () => ({ ok: false, error: '磁盘已满' }))
  a.loadApp()
  await a.tick()
  assert.equal(a.navCountOf('全部文章'), 6)
  assert.equal(a.navCountOf('技术'), 3)
  a.clickArticle('文章1')
  await a.tick()
  assert.ok(a.nodesWithText('标记已读失败：磁盘已满').length, '失败应显示错误')
  assert.equal(a.navCountOf('技术'), 3, '失败的标记不得改动分组计数')
  assert.equal(a.navCountOf('全部文章'), 6, '失败的标记不得改动根计数')
  // (b) 同一订阅两条未读并发确认：两次减计数都生效（函数式更新不互相覆盖）
  const b = createHarness()
  const COUNTS2 = { fa: { total: 6, unread: 3, starred: 0 }, fb: { total: 4, unread: 1, starred: 0 }, fc: { total: 3, unread: 0, starred: 1 }, fd: { total: 2, unread: 3, starred: 0 } }
  const ART2 = [makeArticle(1, 'fa'), makeArticle(7, 'fa'), makeArticle(3, 'fb')]
  b.respond('/dsh-rss/config', () => ({ ok: true, config: {}, stats: STATS }))
  b.respond('/dsh-rss/feeds/list', () => ({ ok: true, feeds: FEEDS.map((f) => ({ ...f })), counts: COUNTS2, stats: STATS }))
  b.respond('/dsh-rss/article', (x) => ({ ok: true, article: ART2.find((y) => y.id === x.id) }))
  const marks = {}
  b.respond('/dsh-rss/mark', (x) => new Promise((r) => { marks[x.id] = r }))
  b.respond('/dsh-rss/feeds/mark-all-read', () => ({ ok: true, marked: 0, pending: { total: 0 } }))
  b.respond('/dsh-rss/articles', articleRouter(ART2))
  b.loadApp()
  await b.tick()
  assert.equal(b.navCountOf('技术'), 4, 'fa3+fb1')
  assert.equal(b.navCountOf('全部文章'), 7)
  b.clickArticle('文章1')
  await b.tick(5)
  b.clickArticle('文章7')
  await b.tick(5)
  marks['art-1']({ ok: true })
  marks['art-7']({ ok: true })
  await b.tick()
  assert.equal(b.navCountOf('技术'), 2, '同订阅两次确认减计数都要生效（并发安全）')
  assert.equal(b.navCountOf('全部文章'), 5, '根计数与各分组计数保持一致')
  // (c) 批量已读失败：计数不动 + 错误可见
  const c = createHarness()
  primeCommon(c)
  c.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  c.respond('/dsh-rss/feeds/mark-all-read', () => ({ ok: false, error: '同步队列暂不可用' }))
  c.loadApp()
  await c.tick()
  c.click('全部已读')
  await c.tick()
  assert.ok(c.nodesWithText('同步队列暂不可用').length, '批量失败应报错')
  assert.equal(c.navCountOf('全部文章'), 6, '批量失败不得改动计数')
})

test('缺陷7：追加期间禁用并显示加载中；失败保留已加载列表；读文后刷新保留已加载页（>100 分多次拉取）', async () => {
  const t = createHarness()
  primeCommon(t)
  const many = []
  for (let i = 1; i <= 130; i++) many.push(makeArticle(i, i <= 22 ? 'fa' : 'fb'))
  const router = articleRouter(many)
  t.respond('/dsh-rss/article', (x) => ({ ok: true, article: many.find((y) => y.id === x.id) }))
  // 阶段 1：追加失败 → 保留 30 条 + 报错 + 按钮恢复可用
  let appendGate = null
  t.respond('/dsh-rss/articles', (body) => {
    if (body.offset > 0 && !appendGate) return { ok: false, error: '服务暂不可用' }
    if (body.offset > 0) return appendGate.promise.then(() => router(body))
    return router(body)
  })
  t.loadApp()
  await t.tick()
  assert.equal(t.titles().length, 30)
  t.click('加载更多')
  await t.tick()
  assert.equal(t.titles().length, 30, '追加失败不得丢已加载列表')
  assert.ok(t.nodesWithText('服务暂不可用').length, '失败应报错')
  const moreBtn = () => t.flatten(t.tree()).find((n) => (n.props.className || '').includes('drss-more') && typeof n.props.onClick === 'function')
  assert.ok(!moreBtn().props.disabled, '失败后「加载更多」应恢复可用')
  assert.ok(t.subtreeText(moreBtn()).includes('加载更多'))
  // 阶段 2：追加挂起 → 按钮禁用 + 显示「加载中…」；放行后补齐
  appendGate = deferred()
  t.click('加载更多')
  await t.tick(5)
  assert.equal(moreBtn().props.disabled, true, '追加期间按钮应禁用')
  assert.ok(t.subtreeText(moreBtn()).includes('加载中…'), '追加期间应显示加载中')
  appendGate.resolve()
  await t.tick()
  assert.equal(t.titles().length, 60)
  // 阶段 3：加载到 120 条后打开一篇文章 → 刷新保留 120 条（单次上限 100 → 0/100 两次拉取）
  t.click('加载更多')
  await t.tick()
  t.click('加载更多')
  await t.tick()
  assert.equal(t.titles().length, 120)
  t.clickArticle('文章130')
  await t.tick()
  assert.equal(t.titles().length, 120, '读文后的刷新应保留已加载页数')
  assert.deepEqual(t.articleBodies().map((x) => x.offset).slice(-2), [0, 100], '已加载 120 条 > 单次上限 100 → 分两次拉取补齐')
})

test('缺陷6（源码级）：外壳定位在自身容器查询之外；三入口高度约束链完整；同级按钮为 flex 行', () => {
  const lines = src.split('\n').map((l) => l.trim())
  const rule = (start) => lines.find((l) => l.startsWith(`'${start}{`))
  // .drss-shell 的 position:relative 必须在基础规则：元素永远不会匹配「自身」的容器查询
  const shell = rule('.drss-shell')
  assert.ok(shell, '应有 .drss-shell 基础规则')
  assert.ok(shell.includes('position:relative'), '基础规则应含 position:relative（抽屉绝对定位的锚点）')
  assert.ok(shell.includes('container-type:inline-size') && shell.includes('flex:1') && shell.includes('min-height:0'))
  const cqStart = lines.findIndex((l) => l.includes('@container (max-width: 920px)'))
  assert.ok(cqStart >= 0, '应有窄容器查询')
  let cqEnd = cqStart
  while (cqEnd < lines.length && lines[cqEnd] !== `'}'`) cqEnd++
  const cq = lines.slice(cqStart, cqEnd + 1).join('\n')
  assert.ok(!cq.includes('.drss-shell'), '容器查询块内不应出现 .drss-shell（永不匹配的死代码）')
  assert.ok(cq.includes('.drss-folders{position:absolute'), '窄容器抽屉仍为绝对定位（锚到基础规则的 relative 外壳）')
  // 高度约束链（main 页/设置面板/右侧栏 tab 三入口共用同一组件）：
  const root = rule('.drss-root')
  assert.ok(/height:100%/.test(root) && /min-height:0/.test(root), '根节点 height:100% + min-height:0')
  const main = rule('.drss-main')
  assert.ok(/flex:1/.test(main) && /min-height:0/.test(main), '主区 flex:1 + min-height:0（撑满外壳且可收缩）')
  for (const pane of ['.drss-folders', '.drss-list', '.drss-read']) {
    assert.ok(/overflow:auto/.test(rule(pane)), `${pane} 应内部滚动（受约束高度下不出溢出）`)
  }
  // 折叠钮与选择钮的同级行布局
  assert.ok(/display:flex/.test(rule('.drss-nav-item')), '.drss-nav-item 应为 flex 行')
})

// ---------- UI 状态持久化 / 自动刷新 / 相对时间（本批新增行为） ----------

test('UI 状态持久化：作用域/筛选/搜索/展开态/自动刷新 写入 localStorage 并在重挂后恢复', async () => {
  const storage = {} // 两个 harness 共享同一存储：模拟「面板卸载重挂 / 刷新页面」
  const mk = () => {
    const t = createHarness({ storage })
    primeCommon(t)
    t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
    return t
  }
  // 第一个实例：改作用域/筛选/搜索/展开态/自动刷新
  const a = mk()
  const mod = a.loadApp()
  await a.tick()
  a.clickNav('技术')
  await a.tick()
  a.click('未读') // 筛选 pill
  a.clickChev() // 展开「技术」
  await a.tick()
  const searchInput = () => a.flatten(a.tree()).find((n) => (n.props.className || '').includes('drss-in') && n.props['aria-label'] === '搜索文章')
  searchInput().props.onChange({ target: { value: '正文' } })
  await a.tick()
  const autoBox = () => a.flatten(a.tree()).find((n) => n.props.type === 'checkbox' && typeof n.props.onChange === 'function')
  autoBox().props.onChange({ target: { checked: true } })
  await a.tick()
  // 已写入存储（作用域/筛选/搜索/展开/自动刷新）
  const saved = JSON.parse(storage['dsh-rss:ui:v1'])
  assert.deepEqual(saved.scope, { kind: 'group', path: '技术' })
  assert.equal(saved.filter, 'unread')
  assert.equal(saved.search, '正文')
  assert.equal(saved.autoRefresh, true)
  assert.equal(saved.expanded['技术'], true)

  // 第二个实例（同一存储）：首渲染即恢复，且恢复的作用域真实驱动查询
  const b = mk()
  b.loadApp()
  await b.tick(300) // 恢复的搜索词带 250ms 防抖：等防抖窗口过后再断言
  const techRow = b.flatten(b.tree()).find((n) =>
    (n.props.className || '').includes('drss-nav-row')
    && (n.children || []).some((c) => c && c.props && c.props.className === 'drss-nav-label' && c.children && c.children[0] === '技术'))
  assert.ok(techRow, '「技术」导航行存在')
  assert.ok(b.foldersText().includes('前端'), '展开态应恢复（子分组可见）')
  const body = b.articleBodies().at(-1)
  assert.deepEqual([...body.groups].sort(), ['技术/前端', '技术/后端'], '恢复的作用域应真实下发子树分组串')
  assert.equal(body.filter, 'unread', '恢复的筛选应随查询下发')
  assert.equal(body.search, '正文', '恢复的搜索词应随查询下发')
  const unreadPill = b.flatten(b.tree()).find((n) => (n.props.className || '').includes('drss-pill') && n.props['aria-pressed'] === 'true')
  assert.ok(b.subtreeText(unreadPill).includes('未读'), '未读筛选 pill 应为按下态')
  const autoBoxB = b.flatten(b.tree()).find((n) => n.props.type === 'checkbox' && typeof n.props.onChange === 'function')
  assert.equal(autoBoxB.props.checked, true, '自动刷新开关应恢复为开')

  // 存储损坏/非法值：不炸、回落默认（scope 非法 → 全部）
  storage['dsh-rss:ui:v1'] = '{broken json'
  const c = mk()
  c.loadApp()
  await c.tick()
  assert.ok(!c.articleBodies().at(-1).groups, '非法持久化数据回落「全部」作用域')

  // 模块级校验函数单元：非法 kind/结构一律回落全部
  // （vm 沙箱内创建的对象与主 realm 原型不同，deepStrictEqual 会因原型不等而失败 → 按字段断言）
  assert.equal(mod._validSavedScope({ kind: 'feed' }).kind, 'all', 'feed 作用域缺 id 应回落')
  assert.equal(mod._validSavedScope({ kind: 'evil', path: 'x' }).kind, 'all', '未知 kind 应回落')
  assert.equal(mod._validSavedScope('junk').kind, 'all')
  assert.equal(mod._validSavedScope(null).kind, 'all')
  assert.equal(mod._validSavedScope({ kind: 'ungrouped' }).kind, 'ungrouped')
  assert.equal(mod._validSavedScope({ kind: 'group', path: '技术' }).path, '技术', '合法 group 作用域应原样保留')
})

test('自动刷新：默认关闭不发请求；开启立即检查一次；10 分钟内切走再切回不重复刷新', async () => {
  const t = createHarness()
  primeCommon(t)
  let refreshCount = 0
  t.respond('/dsh-rss/refresh', () => { refreshCount++; return { ok: true, results: [] } })
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t.loadApp()
  await t.tick()
  assert.equal(refreshCount, 0, '默认关闭：挂载不应自动发刷新请求')

  const autoBox = () => t.flatten(t.tree()).find((n) => n.props.type === 'checkbox' && typeof n.props.onChange === 'function')
  autoBox().props.onChange({ target: { checked: true } })
  await t.tick()
  assert.equal(refreshCount, 1, '开启后应立即检查并刷新一次')

  // 切走（manage）再切回（read）：10 分钟门限内不得重复刷新
  t.click('🗂 订阅管理')
  await t.tick()
  t.click('📖 阅读')
  await t.tick()
  t.click('📖 阅读') // 再触发一次 read 依赖变化（已是 read，无 effect；换 Esc/打开文章等交互不触发）
  await t.tick()
  assert.equal(refreshCount, 1, '10 分钟门限内重挂阅读视图不得重复刷新')

  // 关闭开关：不再自动刷新（tick 由 interval 驱动，沙箱无 interval —— 这里只验证开关状态写回持久层）
  autoBox().props.onChange({ target: { checked: false } })
  await t.tick()
  assert.equal(refreshCount, 1)
})

test('相对时间：列表行显示相对时间，悬停 title 提供绝对时间', async () => {
  const t = createHarness()
  primeCommon(t)
  const now = Date.now()
  const fresh = [
    makeArticle(101, 'fa', { publishedMs: now - 5 * 60 * 1000, title: '刚刚文' }),
    makeArticle(102, 'fa', { publishedMs: now - 3 * 3600 * 1000, title: '今天文' }),
    makeArticle(103, 'fa', { publishedMs: now - 2 * 24 * 3600 * 1000, title: '两天文' }),
    makeArticle(104, 'fa', { publishedMs: now - 30 * 24 * 3600 * 1000, title: '上月文' }),
  ]
  t.respond('/dsh-rss/articles', articleRouter(fresh))
  const mod = t.loadApp()
  await t.tick()
  assert.ok(t.nodesWithText('5 分钟前').length, '5 分钟前的文章显示「5 分钟前」')
  assert.ok(t.nodesWithText('3 小时前').length, '3 小时前的文章显示「3 小时前」')
  assert.ok(t.nodesWithText('2 天前').length, '2 天前的文章显示「2 天前」')
  assert.ok(t.flatten(t.tree()).some((n) => (n.props.className || '').includes('drss-item-meta') && /^\d{4}-\d{2}-\d{2}/.test(String(n.props.title || ''))), 'meta 悬停 title 为绝对时间')
  // 超过一周回绝对时间显示（日期在 .drss-item-date 子节点里）
  const dateTexts = t.flatten(t.tree()).filter((n) => (n.props.className || '') === 'drss-item-date').map((n) => t.subtreeText(n))
  assert.ok(dateTexts.some((s) => /^\d{4}-\d{2}/.test(s)), '30 天前的文章回绝对时间（列表内直接可见）')
  // 单元：未来时间/空值
  assert.equal(mod._relTime(0), '')
  assert.ok(/^\d{4}-/.test(mod._relTime(Date.now() + 60000)), '未来时间回绝对时间')
})

// ---------- 图片代理开关 / 列表摘要行 / 拖宽手柄（本批新增行为） ----------

test('图片开关：默认关（占位文本零 img）；点击写回 ui.imageMode=proxy 并渲染代理 img', async () => {
  const t = createHarness()
  let uiPatch = null
  primeCommon(t) // 先注册默认路由，再覆写 config（后注册者生效）
  t.respond('/dsh-rss/config', (body, method) => {
    if (method === 'POST' && body && body.config && body.config.ui) uiPatch = body.config.ui
    const mode = uiPatch ? uiPatch.imageMode : 'never'
    return { ok: true, config: { ui: { imageMode: mode } }, stats: STATS }
  })
  const imgArticle = makeArticle(201, 'fa', { contentHtml: '<p>开篇</p><img src="https://img.example/pic.png" alt="配图"><p>结尾</p>', summaryHtml: '<p>开篇</p><img src="https://img.example/pic.png" alt="配图"><p>结尾</p>' })
  t.respond('/dsh-rss/article', (body) => ({ ok: true, article: body.id === imgArticle.id ? imgArticle : null }))
  t.respond('/dsh-rss/articles', articleRouter([imgArticle]))
  t.loadApp()
  await t.tick()
  t.clickArticle('文章201')
  await t.tick()
  // 默认关：正文无 img 元素、有占位文本
  assert.ok(!t.flatten(t.tree()).some((n) => n.tag === 'img'), '默认不渲染任何 img（零远程请求）')
  assert.ok(t.nodesWithText('未开启图片显示').length, '默认显示占位文本')
  // 点击「图片：关」→ POST config {ui:{imageMode:'proxy'}} → 代理 img
  t.click('🖼 图片：关')
  await t.tick()
  assert.deepEqual(uiPatch, { imageMode: 'proxy' }, '开关应写回 host 配置 ui.imageMode')
  // 注意排除列表缩略图（className 不同、alt 为空）：定位正文图 drss-art-img
  const img = t.flatten(t.tree()).find((n) => n.tag === 'img' && (n.props.className || '') === 'drss-art-img')
  assert.ok(img, '开启后应渲染正文 img')
  assert.equal(img.props.src, '/dsh-rss/media?u=' + encodeURIComponent('https://img.example/pic.png'), 'src 必须指向本地代理路由')
  assert.equal(img.props.alt, '配图')
  // 再点关：回到占位
  t.click('🖼 图片：开')
  await t.tick()
  assert.equal(uiPatch.imageMode, 'never')
  assert.ok(!t.flatten(t.tree()).some((n) => n.tag === 'img'), '关闭后不得残留 img')
})

test('列表行（qiaomu 式）：顶部 meta（未读点·来源·★·相对时间）+ 摘要行可见', async () => {
  const t = createHarness()
  primeCommon(t)
  t.respond('/dsh-rss/articles', articleRouter([
    makeArticle(301, 'fa', { title: '带摘要的未读收藏文', excerpt: '这是摘要内容第一行，应当出现在列表行里。', starred: true }),
    makeArticle(302, 'fb', { title: '无摘要文', excerpt: '', read: true }),
  ]))
  t.loadApp()
  await t.tick()
  const rowOf = (title) => t.flatten(t.tree()).find((n) => (n.props.className || '').includes('drss-item') && typeof n.props.onClick === 'function' && (n.children || []).some((c) => c && c.props && c.props.className === 'drss-item-title' && c.children && c.children[0] === title))
  const row = rowOf('带摘要的未读收藏文')
  assert.ok(row, '文章行存在')
  const kids = row.children
  // 子节点顺序：meta 行在前、标题、摘要
  assert.equal(kids[0].props.className, 'drss-item-meta', 'meta 行应在最前')
  assert.equal(kids[1].props.className, 'drss-item-title')
  assert.equal(kids[2].props.className, 'drss-item-sum', '摘要行应在标题后')
  assert.ok(t.subtreeText(kids[2]).includes('这是摘要内容第一行'), '摘要内容可见')
  const meta = kids[0]
  assert.ok((meta.children || []).some((c) => c && c.props && c.props.className === 'drss-dot'), '未读点在 meta 行')
  assert.ok((meta.children || []).some((c) => c && c.props && c.props.className === 'drss-star'), '收藏星标在 meta 行')
  assert.ok((meta.children || []).some((c) => c && c.props && c.props.className === 'drss-item-feed' && t.subtreeText(c) === '甲站'), '来源名在 meta 行左侧')
  assert.ok((meta.children || []).some((c) => c && c.props && c.props.className === 'drss-item-date'), '相对时间在 meta 行右侧')
  // 无摘要文章不渲染摘要节点
  const row2 = rowOf('无摘要文')
  assert.ok(!(row2.children || []).some((c) => c && c.props && c.props.className === 'drss-item-sum'), '无摘要不渲染空节点')
})

test('拖宽手柄：pointer 拖动改变列表栏宽度并持久化；键盘左右微调；宽度有钳制', async () => {
  const storage = {}
  const t = createHarness({ storage })
  primeCommon(t)
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t.loadApp()
  await t.tick()
  const split = () => t.flatten(t.tree()).find((n) => (n.props.className || '').includes('drss-split') && typeof n.props.onPointerDown === 'function')
  assert.ok(split(), '拖宽手柄应存在（含 onPointerDown）')
  const mainOf = () => t.flatten(t.tree()).find((n) => (n.props.className || '').includes('drss-main'))
  assert.ok(/212px 320px 5px/.test(String(mainOf().props.style.gridTemplateColumns)), '默认 320px 列宽')
  // 模拟拖拽：down@400 → move@450（+50px）
  split().props.onPointerDown({ pointerId: 1, clientX: 400, currentTarget: { setPointerCapture() {} } })
  split().props.onPointerMove({ pointerId: 1, clientX: 450 })
  await t.tick()
  assert.ok(/212px 370px 5px/.test(String(mainOf().props.style.gridTemplateColumns)), '拖动后宽度应为 370px')
  // 钳制下限 240
  split().props.onPointerDown({ pointerId: 1, clientX: 400, currentTarget: { setPointerCapture() {} } })
  split().props.onPointerMove({ pointerId: 1, clientX: -5000 })
  await t.tick()
  assert.ok(/212px 240px 5px/.test(String(mainOf().props.style.gridTemplateColumns)), '宽度不得低于 240px')
  split().props.onPointerUp({ pointerId: 1, currentTarget: { releasePointerCapture() {} } })
  // 键盘微调 +24
  const before = String(mainOf().props.style.gridTemplateColumns)
  split().props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
  await t.tick()
  assert.ok(!/212px 240px/.test(String(mainOf().props.style.gridTemplateColumns)), '键盘右键应加宽（before=' + before + '）')
  // 持久化
  const saved = JSON.parse(storage['dsh-rss:ui:v1'])
  assert.equal(saved.listW, 264, '拖拽/键盘调整后的宽度应写入 localStorage')
  // 重挂恢复
  const t2 = createHarness({ storage })
  primeCommon(t2)
  t2.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t2.loadApp()
  await t2.tick()
  const main2 = t2.flatten(t2.tree()).find((n) => (n.props.className || '').includes('drss-main'))
  assert.ok(/212px 264px 5px/.test(String(main2.props.style.gridTemplateColumns)), '重挂后应恢复调整过的列表宽度')
})

// ---------- 版本提示 / 播客音频 / 视频嵌入 / 列表缩略图（本批新增行为） ----------

test('版本探测：宿主旧于客户端 → 显示重启指引提示条（可关闭）；版本一致不显示', async () => {
  const mk = (hostVer) => {
    const t = createHarness()
    primeCommon(t)
    t.respond('/dsh-rss/ping', () => ({ ok: true, version: hostVer }))
    t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
    return t
  }
  const old = mk('0.1.0')
  old.loadApp()
  await old.tick()
  assert.ok(old.nodesWithText('仍在运行 v0.1.0').length, '应提示宿主版本落后')
  assert.ok(old.nodesWithText('重启 DSH').length, '提示条应含重启指引')
  // 关闭按钮
  old.click('知道了')
  await old.tick()
  assert.ok(!old.nodesWithText('仍在运行 v0.1.0').length, '点击「知道了」后收起')
  // 版本一致（读 client.js 内的 CLIENT_VERSION 与测试夹具对齐）
  const src2 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')
  const cur = /CLIENT_VERSION = '([^']+)'/.exec(src2)[1]
  const same = mk(cur)
  same.loadApp()
  await same.tick()
  assert.ok(!same.nodesWithText('仍在运行').length, '宿主与客户端同版本不应提示')
})

test('播客 enclosure：点击前只有加载按钮（零音频请求），点击后渲染 audio 直连源', async () => {
  const t = createHarness()
  primeCommon(t)
  const pod = makeArticle(401, 'fa', { enclosureUrl: 'https://audio.example/ep1.mp3', enclosureType: 'audio/mpeg' })
  const notPod = makeArticle(402, 'fb', { enclosureUrl: 'https://example.com/doc.pdf', enclosureType: 'application/pdf' })
  t.respond('/dsh-rss/article', (body) => ({ ok: true, article: body.id === pod.id ? pod : notPod }))
  t.respond('/dsh-rss/articles', articleRouter([pod, notPod]))
  t.loadApp()
  await t.tick()
  t.clickArticle('文章401')
  await t.tick()
  const audioEl = () => t.flatten(t.tree()).find((n) => n.tag === 'audio')
  assert.ok(!audioEl(), '点击前不得渲染 audio（不发起网络请求）')
  t.click('▶ 加载播客音频')
  await t.tick()
  const au = audioEl()
  assert.ok(au, '点击后应渲染 audio')
  assert.equal(au.props.src, 'https://audio.example/ep1.mp3', '音频直连源（不经过图片代理）')
  assert.equal(au.props.controls, true)
  // 非音频 enclosure 不渲染任何媒体块
  t.clickArticle('文章402')
  await t.tick()
  assert.ok(!audioEl())
  assert.ok(!t.nodesWithText('加载播客音频').length)
})

test('视频嵌入：YouTube/B 站链接点击加载官方播放器；普通链接无视频块', async () => {
  const t = createHarness()
  primeCommon(t)
  const yt = makeArticle(403, 'fa', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })
  const bili = makeArticle(404, 'fb', { url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2' })
  const normal = makeArticle(405, 'fc', { url: 'https://example.com/post/1' })
  t.respond('/dsh-rss/article', (body) => ({ ok: true, article: [yt, bili, normal].find((x) => x.id === body.id) }))
  t.respond('/dsh-rss/articles', articleRouter([yt, bili, normal]))
  t.loadApp()
  await t.tick()
  const frame = () => t.flatten(t.tree()).find((n) => n.tag === 'iframe')
  // YouTube
  t.clickArticle('文章403')
  await t.tick()
  assert.ok(!frame(), '点击前不加载 iframe（零自动请求）')
  t.click('▶ 在阅读器内播放视频')
  await t.tick()
  let f = frame()
  assert.ok(f, '点击后应渲染 iframe')
  assert.equal(f.props.src, 'https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=0&playsinline=1')
  assert.ok(String(f.props.sandbox).includes('allow-scripts'), 'iframe 应带 sandbox')
  // B 站（切文章后需再点击：视频也是点击加载）
  t.clickArticle('文章404')
  await t.tick()
  assert.ok(!frame(), '切到新文章后回到点击加载态')
  t.click('▶ 在阅读器内播放视频')
  await t.tick()
  f = frame()
  assert.equal(f.props.src, 'https://player.bilibili.com/player.html?isOutside=true&bvid=BV1xx411c7mD&p=2&autoplay=0&high_quality=1&danmaku=0')
  // 普通链接
  t.clickArticle('文章405')
  await t.tick()
  assert.ok(!frame())
  assert.ok(!t.nodesWithText('在阅读器内播放视频').length)
})

test('列表缩略图：图片开关开启时取首图经代理；关闭时零缩略图请求', async () => {
  const mk = (mode) => {
    const t = createHarness()
    primeCommon(t)
    t.respond('/dsh-rss/config', (body, method) => {
      const next = method === 'POST' && body && body.config && body.config.ui ? body.config.ui.imageMode : mode
      return { ok: true, config: { ui: { imageMode: next } }, stats: STATS }
    })
    const art = makeArticle(501, 'fa', { contentHtml: '<p>文</p><img src="https://img.example/cover.png" alt="封面">', summaryHtml: '<p>文</p>' })
    t.respond('/dsh-rss/articles', articleRouter([art]))
    return t
  }
  const off = mk('never')
  off.loadApp()
  await off.tick()
  assert.ok(!off.flatten(off.tree()).some((n) => (n.props.className || '') === 'drss-item-thumb'), '图片关闭时不渲染缩略图')
  const on = mk('proxy')
  on.loadApp()
  await on.tick()
  const thumb = on.flatten(on.tree()).find((n) => (n.props.className || '') === 'drss-item-thumb')
  assert.ok(thumb, '图片开启时应渲染缩略图')
  const img = thumb.children[0]
  assert.equal(img.tag, 'img')
  assert.equal(img.props.src, '/dsh-rss/media?u=' + encodeURIComponent('https://img.example/cover.png'), '缩略图走本地代理')
})

// ---------- 刷新编排覆盖 FreshRSS / 旧缓存图片提示 / 设置面板专用模式（本批新增） ----------

test('「⟳ 刷新」编排：有 greader 订阅且账号可用时刷新后自动同步；纯 standalone 不多打', async () => {
  const mk = (feeds, freshrss) => {
    const t = createHarness()
    t.respond('/dsh-rss/config', () => ({ ok: true, config: { freshrss }, stats: STATS }))
    t.respond('/dsh-rss/feeds/list', () => ({ ok: true, feeds: feeds.map((f) => ({ ...f })), counts: {}, stats: STATS }))
    t.respond('/dsh-rss/refresh', () => ({ ok: true, results: [] }))
    t.respond('/dsh-rss/freshrss/sync', () => ({ ok: true, feeds: 2, items: 5, pages: 'done', incremental: true, pushed: {}, pushFailures: [], remoteMarks: 0, insecure: false }))
    t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
    t.respond('/dsh-rss/article', (body) => ({ ok: true, article: ARTICLES.find((x) => x.id === body.id) }))
    return t
  }
  const greaderFeeds = [{ id: 'g1', kind: 'greader', url: 'feed/1', externalFeedId: 'feed/1', title: 'G 站', group: '' }]
  const frOk = { baseUrl: 'https://fr.test', username: 'u', enabled: true, hasApiPassword: true, insecureHttp: false, configured: true, needsReset: false }

  // greader + 账号可用 → refresh 之后紧跟 freshrss/sync，消息合并两者
  const a = mk(greaderFeeds, frOk)
  a.loadApp()
  await a.tick()
  a.click('⟳ 刷新')
  await a.tick()
  const pathsA = a.fetchLog.map((f) => f.path)
  assert.ok(pathsA.includes('/dsh-rss/refresh'), '应先调 refresh')
  assert.ok(pathsA.includes('/dsh-rss/freshrss/sync'), '有 greader 订阅时刷新应继续同步 FreshRSS')
  assert.ok(pathsA.indexOf('/dsh-rss/freshrss/sync') > pathsA.indexOf('/dsh-rss/refresh'), '同步在刷新之后')
  assert.ok(a.nodesWithText('FreshRSS 同步完成').length, '应汇报同步结果')

  // 纯 standalone → 不多发 sync
  const b = mk(FEEDS, frOk)
  b.loadApp()
  await b.tick()
  b.click('⟳ 刷新')
  await b.tick()
  assert.ok(!b.fetchLog.some((f) => f.path === '/dsh-rss/freshrss/sync'), '纯 standalone 不应触发同步')

  // greader 存在但账号不可用（未配置）→ 不发 sync
  const c = mk(greaderFeeds, { baseUrl: '', username: '', enabled: false, hasApiPassword: false, insecureHttp: false, configured: false, needsReset: false })
  c.loadApp()
  await c.tick()
  c.click('⟳ 刷新')
  await c.tick()
  assert.ok(!c.fetchLog.some((f) => f.path === '/dsh-rss/freshrss/sync'), '账号不可用不应触发同步')

  // 自动刷新同样编排（静默）：开启后 greader+可用 → 两个请求都发出
  const d = mk(greaderFeeds, frOk)
  d.loadApp()
  await d.tick()
  const autoBox = () => d.flatten(d.tree()).find((n) => n.props.type === 'checkbox' && typeof n.props.onChange === 'function')
  autoBox().props.onChange({ target: { checked: true } })
  await d.tick()
  assert.ok(d.fetchLog.some((f) => f.path === '/dsh-rss/refresh'), '自动刷新应包含 refresh')
  assert.ok(d.fetchLog.some((f) => f.path === '/dsh-rss/freshrss/sync'), '自动刷新应包含 FreshRSS 同步（greader 用户）')
})

test('旧缓存图片提示：图片开启且正文含 ［图片 标记 → 显示恢复指引；无标记或未开启不显示', async () => {
  const mk = (mode, html) => {
    const t = createHarness()
    primeCommon(t)
    t.respond('/dsh-rss/config', (body, method) => {
      const next = method === 'POST' && body && body.config && body.config.ui ? body.config.ui.imageMode : mode
      return { ok: true, config: { ui: { imageMode: next } }, stats: STATS }
    })
    const art = makeArticle(601, 'fa', { contentHtml: html, summaryHtml: html })
    t.respond('/dsh-rss/article', (body) => ({ ok: true, article: body.id === art.id ? art : null }))
    t.respond('/dsh-rss/articles', articleRouter([art]))
    return { t, art }
  }
  const legacyHtml = '<p>正文段落</p>［图片：封面］<p>尾段</p>'

  const on = mk('proxy', legacyHtml)
  on.t.loadApp()
  await on.t.tick()
  on.t.clickArticle('文章601')
  await on.t.tick()
  assert.ok(on.t.nodesWithText('旧版缓存的图文').length, '图片开启 + 旧标记 → 应显示恢复指引')

  const fresh = mk('proxy', '<p>正文</p><img src="https://img.example/a.png" alt="a">')
  fresh.t.loadApp()
  await fresh.t.tick()
  fresh.t.clickArticle('文章601')
  await fresh.t.tick()
  assert.ok(!fresh.t.nodesWithText('旧版缓存的图文').length, '新缓存（含 img）不应显示指引')

  const off = mk('never', legacyHtml)
  off.t.loadApp()
  await off.t.tick()
  off.t.clickArticle('文章601')
  await off.t.tick()
  assert.ok(!off.t.nodesWithText('旧版缓存的图文').length, '图片关闭时不显示该指引')
})

test('设置面板专用模式：无阅读 tab、首屏为订阅管理、不写浏览上下文持久化', async () => {
  const storage = {}
  const t = createHarness({ storage })
  primeCommon(t)
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t.loadApp({ mode: 'settings' })
  await t.tick()
  // 首屏是订阅管理（不是阅读工作台）
  assert.ok(t.nodesWithText('订阅管理').length, 'settings 模式首屏应为订阅管理')
  assert.ok(!t.flatten(t.tree()).some((n) => (n.props.className || '').includes('drss-main')), 'settings 模式不应渲染三栏阅读工作台')
  // 没有「阅读」tab
  assert.ok(!t.nodesWithText('📖 阅读').length, 'settings 模式不应有阅读 tab')
  // 其余分区可达
  t.click('☁️ FreshRSS')
  await t.tick()
  assert.ok(t.nodesWithText('FreshRSS').length)
  // 不写持久化（settings 面板不得污染阅读面板的浏览状态）
  assert.ok(!storage['dsh-rss:ui:v1'], 'settings 模式不应写 localStorage')
  // 对照：完整模式仍写
  const t2 = createHarness({ storage })
  primeCommon(t2)
  t2.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t2.loadApp()
  await t2.tick()
  assert.ok(storage['dsh-rss:ui:v1'], '完整模式应正常持久化')
})

// ---------- 三栏展开收起 / 专注模式 / 复制链接 / 字号 / 抓取全文（本批新增） ----------

test('订阅栏可收起展开：顶栏 ☰ 切换、网格列随之增减、状态持久化', async () => {
  const storage = {}
  const t = createHarness({ storage })
  primeCommon(t)
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t.loadApp()
  await t.tick()
  const mainOf = () => t.flatten(t.tree()).find((n) => (n.props.className || '').includes('drss-main'))
  const foldersPane = () => t.flatten(t.tree()).find((n) => n.props.className === 'drss-folders')
  const toggle = () => t.flatten(t.tree()).find((n) => (n.props.className || '').includes('drss-folders-toggle') && typeof n.props.onClick === 'function')
  assert.ok(toggle(), '顶栏应有订阅栏开关')
  assert.ok(foldersPane(), '默认显示订阅栏')
  assert.ok(/212px 320px 5px/.test(String(mainOf().props.style.gridTemplateColumns)))
  toggle().props.onClick({})
  await t.tick()
  assert.ok(!foldersPane(), '收起后订阅栏不渲染')
  assert.ok(/^320px 5px/.test(String(mainOf().props.style.gridTemplateColumns)), '收起后网格列应从列表栏开始')
  assert.equal(JSON.parse(storage['dsh-rss:ui:v1']).foldersHidden, true, '收起状态持久化')
  toggle().props.onClick({})
  await t.tick()
  assert.ok(foldersPane() && /212px/.test(String(mainOf().props.style.gridTemplateColumns)), '再点恢复')
})

test('专注模式：打开文章后收起列表全宽阅读，退出恢复；状态持久化；F 键源码级存在', async () => {
  const storage = {}
  const t = createHarness({ storage })
  primeCommon(t)
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t.loadApp()
  await t.tick()
  const listPane = () => t.flatten(t.tree()).find((n) => n.props.className === 'drss-list')
  const mainOf = () => t.flatten(t.tree()).find((n) => (n.props.className || '').includes('drss-main'))
  // 未打开文章时列表始终显示（专注只作用于阅读）
  const focusBtn0 = () => t.flatten(t.tree()).find((n) => typeof n.props.onClick === 'function' && t.subtreeText(n).includes('专注'))
  t.clickArticle('文章1')
  await t.tick()
  assert.ok(listPane(), '打开文章后默认仍显示列表')
  t.click('⇥ 专注')
  await t.tick()
  assert.ok(!listPane(), '专注模式应收起列表')
  assert.ok(/212px minmax\(0,1fr\)/.test(String(mainOf().props.style.gridTemplateColumns)), '阅读栏全宽（订阅栏仍在）')
  assert.equal(JSON.parse(storage['dsh-rss:ui:v1']).focusRead, true, '专注状态持久化')
  t.click('⇤ 退出专注')
  await t.tick()
  assert.ok(listPane(), '退出专注恢复列表')
  // F 键快捷键（键盘监听在沙箱不可注入，源码级断言）
  const src2 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')
  assert.ok(/e\.key === 'f'/.test(src2), 'F 键应切换专注模式')
})

test('复制链接：clipboard API 写入文章链接并提示成功', async () => {
  let copied = null
  const t = createHarness({ navigator: { clipboard: { writeText: (x) => { copied = x; return Promise.resolve() } } } })
  primeCommon(t)
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t.loadApp()
  await t.tick()
  t.clickArticle('文章1')
  await t.tick()
  t.click('🔗 复制链接')
  await t.tick()
  assert.equal(copied, 'https://example.com/1')
  assert.ok(t.nodesWithText('链接已复制').length)
})

test('阅读字号 A+/A−：正文行内字号随之变化并持久化', async () => {
  const storage = {}
  const t = createHarness({ storage })
  primeCommon(t)
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t.loadApp()
  await t.tick()
  t.clickArticle('文章1')
  await t.tick()
  const body = () => t.flatten(t.tree()).find((n) => (n.props.className || '') === 'drss-body')
  assert.equal(body().props.style.fontSize, '17px', '默认 17px')
  t.click('A+')
  await t.tick()
  assert.equal(body().props.style.fontSize, '18px')
  t.click('A−')
  await t.tick()
  assert.equal(body().props.style.fontSize, '17px')
  t.click('A+')
  await t.tick()
  assert.equal(JSON.parse(storage['dsh-rss:ui:v1']).readFont, 18, '字号持久化')
  // 重挂恢复
  const t2 = createHarness({ storage })
  primeCommon(t2)
  t2.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t2.loadApp()
  await t2.tick()
  t2.clickArticle('文章1')
  await t2.tick()
  assert.equal(t2.flatten(t2.tree()).find((n) => (n.props.className || '') === 'drss-body').props.style.fontSize, '18px', '重挂后恢复字号')
})

test('抓取全文：按钮请求路由、临时替换正文并可切回缓存；切文章自动清', async () => {
  const t = createHarness()
  primeCommon(t)
  const a1 = makeArticle(701, 'fa', { contentHtml: '<p>缓存的摘要正文</p>', summaryHtml: '<p>缓存的摘要正文</p>' })
  const a2 = makeArticle(702, 'fb', { contentHtml: '<p>第二篇</p>', summaryHtml: '<p>第二篇</p>' })
  t.respond('/dsh-rss/article', (body) => ({ ok: true, article: [a1, a2].find((x) => x.id === body.id) }))
  t.respond('/dsh-rss/articles', articleRouter([a1, a2]))
  t.respond('/dsh-rss/article/fetch-full', (body) => {
    assert.equal(body.id, a1.id, '应带当前文章 id')
    return { ok: true, html: '<p>这是从原文页抓取的完整正文XYZ</p>', chars: 1234 }
  })
  t.loadApp()
  await t.tick()
  t.clickArticle('文章701')
  await t.tick()
  assert.ok(t.nodesWithText('缓存的摘要正文').length)
  assert.ok(!t.nodesWithText('完整正文XYZ').length)
  t.click('⤓ 抓取全文')
  await t.tick()
  assert.ok(t.nodesWithText('完整正文XYZ').length, '抓取后正文被替换')
  assert.ok(t.nodesWithText('以下为抓取的原文正文').length, '应有抓取态提示')
  assert.ok(t.nodesWithText('约 1234 字符').length, '应汇报抓取结果')
  // 切回缓存
  t.click('↩ 缓存正文')
  await t.tick()
  assert.ok(t.nodesWithText('缓存的摘要正文').length, '切回缓存正文')
  assert.ok(!t.nodesWithText('完整正文XYZ').length)
  // 再抓取 → 切文章自动恢复缓存
  t.click('⤓ 抓取全文')
  await t.tick()
  assert.ok(t.nodesWithText('完整正文XYZ').length)
  t.clickArticle('文章702')
  await t.tick()
  assert.ok(t.nodesWithText('第二篇').length)
  assert.ok(!t.nodesWithText('完整正文XYZ').length, '切换文章后全文态自动清除')
})

// ---------- 订阅行双计数 / 已读隐藏 / 订阅栏快速添加（本批新增） ----------

test('订阅行双计数：未读>0 显示「未读/总数」，全已读显示灰色总数；分组/根行为求和', async () => {
  const t = createHarness()
  primeCommon(t)
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t.loadApp()
  await t.tick()
  const pillOf = (label) => {
    const row = t.flatten(t.tree()).find((n) => (n.props.className || '').includes('drss-nav-row')
      && (n.children || []).some((c) => c && c.props && c.props.className === 'drss-nav-label' && c.children && c.children[0] === label))
    assert.ok(row, `行「${label}」应存在`)
    return (row.children || []).find((c) => c && c.props && (c.props.className || '').startsWith('drss-nav-count'))
  }
  await t.showAll()
  // 全部：6/14；技术（fa2+fb1 / 5+4）：3/9；丙站（unread 0/total 3）：dim 的 '3'
  assert.equal(String(pillOf('全部文章').children[0]), '6/14')
  assert.equal(String(pillOf('技术').children[0]), '3/9')
  const dim = pillOf('丙站')
  assert.equal(String(dim.children[0]), '3')
  assert.ok((dim.props.className || '').includes('dim'), '全已读的总数应为灰态')
  assert.equal(dim.props['aria-label'], '共 3 篇，无未读')
})

test('已读隐藏（默认开）：全已读的订阅与分组隐藏；选中项保留；可切换并持久化；全空有空态', async () => {
  const storage = {}
  const t = createHarness({ storage })
  primeCommon(t)
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t.loadApp()
  await t.tick()
  const foldersText = () => t.foldersText()
  // 默认（只看未读）：丙站（未读 0）隐藏；生活分组整体隐藏；有未读的都在
  assert.ok(!foldersText().includes('丙站'), '全已读订阅默认隐藏')
  assert.ok(!foldersText().includes('生活'), '全已读分组默认隐藏')
  assert.ok(foldersText().includes('技术') && foldersText().includes('丁站'), '有未读的照常显示')
  // 选中已读订阅：保留显示（不丢上下文）
  t.click('只看未读') // 切到显示全部
  await t.tick()
  assert.ok(foldersText().includes('丙站'), '切换后显示全部')
  assert.equal(JSON.parse(storage['dsh-rss:ui:v1']).hideDone, false, '开关状态持久化')
  t.clickNav('丙站')
  await t.tick()
  t.click('显示全部') // 回到只看未读
  await t.tick()
  assert.ok(foldersText().includes('丙站'), '当前选中的订阅即使已读完也保留显示')
  // 全部已读 → 空态提示（把所有订阅标成已读：counts 全 0）
  let countsZero = false
  const t2 = createHarness()
  t2.respond('/dsh-rss/config', () => ({ ok: true, config: {}, stats: { ...STATS, unread: 0 } }))
  t2.respond('/dsh-rss/feeds/list', () => {
    const c = countsZero
      ? Object.fromEntries(FEEDS.map((f) => [f.id, { total: 5, unread: 0, starred: 0 }]))
      : { fa: { total: 5, unread: 1, starred: 0 } }
    return { ok: true, feeds: FEEDS.map((f) => ({ ...f })), counts: c, stats: STATS }
  })
  t2.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t2.respond('/dsh-rss/refresh', () => ({ ok: true, results: [{ feedId: 'fa', title: '甲站', ok: true, added: 0, updated: 0, kept: 5 }] }))
  t2.loadApp()
  await t2.tick()
  // 用「🎉」区分空态提示与列表栏固有的「全部已读」按钮（同名）
  assert.ok(!t2.nodesWithText('🎉').length, '尚有未读时无空态')
  countsZero = true
  t2.click('⟳ 刷新')
  await t2.tick()
  assert.ok(t2.nodesWithText('🎉 全部已读').length, '全部已读时应显示空态提示')
})

test('订阅栏快速添加：输入地址点 ＋（或回车）调 feeds/add，成功后清空并刷新', async () => {
  const t = createHarness()
  primeCommon(t)
  let addedBody = null
  t.respond('/dsh-rss/feeds/add', (body) => { addedBody = body; return { ok: true, feed: { id: 'fnew', kind: 'standalone', title: '新订阅', group: '' }, counts: { added: 3 }, insecure: false } })
  t.respond('/dsh-rss/articles', articleRouter(ARTICLES))
  t.loadApp()
  await t.tick()
  const quickInput = () => t.flatten(t.tree()).find((n) => n.tag === 'input' && (n.props['aria-label'] || '') === '快速添加订阅')
  assert.ok(quickInput(), '订阅栏应有快速添加输入框')
  quickInput().props.onChange({ target: { value: 'https://new.example/feed.xml' } })
  await t.tick()
  const addBtn = () => t.flatten(t.tree()).find((n) => typeof n.props.onClick === 'function' && t.subtreeText(n) === '＋')
  addBtn().props.onClick({})
  await t.tick()
  assert.equal(addedBody.url, 'https://new.example/feed.xml', '应调 feeds/add 且只带地址')
  assert.equal(addedBody.title, undefined)
  assert.ok(t.nodesWithText('已添加「新订阅」').length, '应汇报添加结果')
  assert.equal(quickInput().props.value, '', '成功后清空输入框')
  // 回车提交
  quickInput().props.onChange({ target: { value: 'https://new2.example/feed' } })
  await t.tick()
  quickInput().props.onKeyDown({ key: 'Enter', preventDefault() {} })
  await t.tick()
  assert.equal(addedBody.url, 'https://new2.example/feed', '回车应提交')
  // 空地址：提示且不发请求
  const before = t.fetchLog.length
  addBtn().props.onClick({})
  await t.tick()
  assert.ok(t.nodesWithText('请先粘贴').length, '空地址应提示')
  assert.equal(t.fetchLog.length, before, '空地址不应发请求')
})

// ---------- 响应鲁棒解析：空/非 JSON/中断响应不再抛天书（fetch-full 实机 bug 的客户端半边） ----------

test('parseRes：空体/HTML 错误页/读体失败 → 可读错误对象；正常 JSON 与 json() 形态照常', async () => {
  const src2 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')
  const loads = []
  const sandbox = { window: { __ModuleLoader__: { load: (s) => loads.push(s) } }, console }
  vm.createContext(sandbox)
  vm.runInContext(src2, sandbox)
  const mod = loads[0].factory(() => ({ createElement: () => ({}) }))
  const parse = mod._parseRes

  // 正常 JSON 文本
  const ok = await parse({ text: async () => '{"ok":true,"v":1}' })
  assert.deepEqual({ ok: ok.ok, v: ok.v }, { ok: true, v: 1 })
  // 空体（被掐断的响应）→ 可读错误，绝不抛 "Unexpected end of JSON input"
  const empty = await parse({ text: async () => '' })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /响应为空/)
  assert.match(empty.error, /超时|重试/)
  // HTML 错误页（网关 502 等）→ 非 JSON 错误，附原文片段
  const html = await parse({ text: async () => '<html><body>502 Bad Gateway</body></html>' })
  assert.equal(html.ok, false)
  assert.match(html.error, /不是 JSON/)
  assert.match(html.error, /502 Bad Gateway/)
  // 只有 json() 的旧形态（测试 harness / 旧宿主）→ 照常工作
  const legacy = await parse({ json: async () => ({ ok: true, via: 'json' }) })
  assert.deepEqual({ ok: legacy.ok, via: legacy.via }, { ok: true, via: 'json' })
  // 读体本身抛错（连接中断）
  const dead = await parse({ text: async () => { throw new Error('aborted') } })
  assert.equal(dead.ok, false)
  assert.match(dead.error, /aborted/)
})
