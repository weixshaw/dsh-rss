import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')

// ---------- 基础加载（无 hooks 运行时） ----------

function loadClient({ fetchImpl } = {}) {
  const loads = []
  const fetchCalls = []
  const warns = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => loads.push(spec) } },
    fetch: fetchImpl || (async (url, opts) => {
      fetchCalls.push({ url, opts })
      return { json: async () => ({ ok: true }) }
    }),
    URL,
    setTimeout,
    clearTimeout,
    console: { // 记录告警：降级必须可见，不允许静默吞掉注册失败
      warn: (...a) => warns.push(a.map((x) => String(x)).join(' ')),
      error: (...a) => console.error(...a),
      log: (...a) => console.log(...a),
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: 'client.js' })
  assert.equal(loads.length, 1, '应恰好调用一次 __ModuleLoader__.load')
  const spec = loads[0]
  const ReactStub = {
    createElement: (tag, props, ...children) => ({ tag, props: props || {}, children }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
  }
  const mod = spec.factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error(`意外的 require: ${name}`)
  })
  return { spec, mod, ReactStub, fetchCalls, warns }
}

// ---------- 可运行 hooks 的最小 React（组件级行为回归） ----------

function createHarness() {
  const fetchLog = []
  const routes = {}
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
  const hookMemoDeps = []
  const hookMemoVals = []
  let hookIdx = 0
  const effectPrev = []
  const pendingEffects = []
  let component = null
  let tree = null
  let rerenderScheduled = false

  const rerender = () => {
    if (!component) return
    hookIdx = 0
    tree = component({})
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
      // 跨渲染稳定引用（请求序号 / 搜索框引用）：与 useState 共享 hook 槽位计数
      if (!hookRefs[hookIdx]) hookRefs[hookIdx] = { current: typeof init === 'function' ? init() : init }
      return hookRefs[hookIdx++]
    },
    useMemo(fn, deps) {
      const slot = hookIdx++
      const prev = hookMemoDeps[slot]
      if (!prev || !deps || prev.length !== deps.length || deps.some((d, j) => !Object.is(d, prev[j]))) {
        hookMemoDeps[slot] = deps
        hookMemoVals[slot] = fn()
      }
      return hookMemoVals[slot]
    },
    useCallback(fn) {
      return fn
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

  const loadApp = () => {
    const loads = []
    const sandbox = {
      window: { __ModuleLoader__: { load: (s) => loads.push(s) }, confirm: () => true, prompt: () => null },
      fetch: sandboxFetch,
      FileReader: class {
        readAsText(file) {
          queueMicrotask(() => { this.result = file.text; this.onload() })
        }
      },
      Blob: class {},
      URL,
      setTimeout,
      clearTimeout,
      console,
    }
    vm.createContext(sandbox)
    vm.runInContext(src, sandbox, { filename: 'client.js' })
    const mod = loads[0].factory((n) => (n === 'react' ? ReactLike : null))
    component = mod._App
    if (!component) throw new Error('client.js 需要导出 _App 供行为测试')
    hookIdx = 0
    tree = component({})
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
  const nodesWithText = (text, exact = false) => flatten(tree).filter((n) => {
    const kids = (n.children || []).filter((c) => typeof c === 'string')
    return exact ? kids.includes(text) : kids.some((c) => String(c).includes(text))
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
  const click = (text, exact = true) => {
    const node = flatten(tree).find((n) => typeof n.props.onClick === 'function' && (exact ? subtreeText(n).includes(text) : subtreeText(n).includes(text)))
    assert.ok(node, `找不到可点击的“${text}”`)
    node.props.onClick({ stopPropagation: () => {}, target: { value: '' } })
  }

  return { respond, fetchLog, loadApp, tick, tree: () => tree, nodesWithText, click, hookValues }
}

// ---------- 契约测试 ----------

test('模块契约：id、factory、exports.apply、exports.inject', () => {
  const { spec, mod } = loadClient()
  assert.equal(spec.id, 'dsh-rss')
  assert.equal(typeof spec.factory, 'function')
  assert.equal(typeof mod.apply, 'function')
  // 模块级只声明 slots（fiber 等待其就绪）；betterSidebar 走嵌套 inject 保持可选。
  // 注意 realm 安全断言：mod.inject 来自 vm 上下文，deepStrictEqual 会因原型不同而失败。
  assert.ok(Array.isArray(mod.inject) && mod.inject.length === 1 && mod.inject[0] === 'slots', "exports.inject 应为 ['slots']")
})

test('注册契约：settings.section（名称/标签/组件）', () => {
  const { mod, warns } = loadClient()
  const injected = []
  let registered = null
  const slots = {
    inject: (name, cb) => injected.push([name, cb]),
    register: (opts, comp) => { registered = { opts, comp }; return () => {} },
  }
  mod.apply({ get: (n) => (n === 'slots' ? slots : undefined) })
  const seats = injected.map((x) => x[0])
  assert.ok(seats.includes('settings.section'), 'settings.section 座位应注册')
  assert.ok(seats.includes('main'), 'main 座位应注册（左侧主导航页）')
  assert.ok(seats.includes('sidebar.panellist'), 'sidebar.panellist 座位应注册（左侧主导航行）')
  const settingsCb = injected.find((x) => x[0] === 'settings.section')[1]
  settingsCb()
  assert.ok(registered)
  assert.equal(registered.opts.name, 'settings.section')
  assert.equal(registered.opts.id, 'dsh-rss')
  assert.equal(registered.opts.label(), 'RSS 阅读')
  const tree = registered.comp({})
  assert.equal(typeof tree.tag, 'function')
  assert.equal(tree.tag.name, 'App')
  // 该测试 ctx 未提供 ctx.inject（模拟无嵌套 inject 能力的宿主）：
  // Better Sidebar 降级为可见告警，settings.section 与主导航注册不受影响
  assert.ok(warns.some((w) => w.includes('ctx.inject')), '缺少 ctx.inject 时应输出可见告警而非静默')
})

test('可选 betterSidebar tab：嵌套 ctx.inject 声明式响应式注册', () => {
  const { mod } = loadClient()
  const slots = { inject: () => {}, register: () => () => {} }
  const injects = []
  mod.apply({
    get: (n) => (n === 'slots' ? slots : undefined),
    inject: (deps, cb) => injects.push({ deps: [...deps], cb }),
  })
  assert.equal(injects.length, 1, '应恰好注册一次嵌套 ctx.inject')
  assert.deepEqual(injects[0].deps, ['betterSidebar'], "嵌套依赖应为 ['betterSidebar']")

  const tabs = []
  const disposers = []
  const makeScope = (bs) => ({
    get: (n) => (n === 'betterSidebar' ? bs : undefined),
    // Cordis 语义：effect 体立即执行；返回的注销函数在 scope 销毁时运行
    effect: (fn) => { const off = fn(); disposers.push(off); return () => off() },
  })
  const makeBs = () => ({
    registerTab: (spec) => { tabs.push(spec); return () => { tabs.pop() } },
  })

  // 服务晚到：apply 时不存在 → 回调尚未运行；服务上线 → 回调恰好运行一次并注册
  const bs1 = makeBs()
  injects[0].cb(makeScope(bs1))
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].id, 'dsh-rss:reader')
  assert.equal(tabs[0].title, 'RSS 阅读')
  assert.equal(tabs[0].single, true)
  assert.equal(typeof tabs[0].component, 'function')

  // 服务下线：scope 的 effect disposer 注销 tab（无残留、disposer 不丢弃）
  disposers.splice(0)[0]()
  assert.equal(tabs.length, 0)

  // 服务恢复（新实例）：回调重跑，重新注册恰好一次（旧注册已注销，无重复 id）
  const bs2 = makeBs()
  injects[0].cb(makeScope(bs2))
  assert.equal(tabs.length, 1)
  disposers.splice(0)[0]()
  assert.equal(tabs.length, 0)
})

test('betterSidebar 不进入模块级 inject，root ctx 不做一次性查找（未声明访问守卫）', () => {
  const { mod } = loadClient()
  const slots = { inject: () => {}, register: () => () => {} }
  const accessed = []
  const ctx = {
    get: (n) => {
      accessed.push(n)
      if (n === 'betterSidebar') throw new Error('cannot get property "betterSidebar" without inject')
      return n === 'slots' ? slots : undefined
    },
    inject: () => {},
  }
  mod.apply(ctx) // 不得经 root get 触碰 betterSidebar，也不得抛错
  assert.ok(!accessed.includes('betterSidebar'), 'root ctx 不应访问 betterSidebar')
})

test('betterSidebar 服务缺少 registerTab：可见告警、不抛错', () => {
  const { mod, warns } = loadClient()
  const slots = { inject: () => {}, register: () => () => {} }
  let scopedCb = null
  mod.apply({
    get: (n) => (n === 'slots' ? slots : undefined),
    inject: (deps, cb) => { scopedCb = cb },
  })
  scopedCb({ get: (n) => (n === 'betterSidebar' ? {} : undefined), effect: () => {} })
  assert.ok(warns.some((w) => w.includes('registerTab')), '能力缺失应输出可见告警')
})

test('slots 缺失时 apply 直接返回（不抛错）', () => {
  const { mod } = loadClient()
  mod.apply({ get: () => undefined })
})

test('_call：POST /dsh-rss/<method>，带 X-DSH-RSS 头', async () => {
  const { mod, fetchCalls } = loadClient()
  await mod._call('ping', { a: 1 })
  assert.equal(fetchCalls[0].url, '/dsh-rss/ping')
  assert.equal(fetchCalls[0].opts.method, 'POST')
  assert.equal(fetchCalls[0].opts.headers['x-dsh-rss'], '1')
  assert.deepEqual(JSON.parse(fetchCalls[0].opts.body), { a: 1 })
})

// ---------- renderSafe 安全渲染 ----------

test('renderSafe：白名单渲染，无 innerHTML 语义', () => {
  const { mod } = loadClient()
  const nodes = mod.renderSafe('<p>你好<b>世界</b></p>')
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].tag, 'p')
  assert.equal(nodes[0].children[0], '你好')
  assert.equal(nodes[0].children[1].tag, 'b')
  assert.equal(nodes[0].children[1].children[0], '世界')
})

test('renderSafe：<br>/<hr> 不吞兄弟节点', () => {
  const { mod } = loadClient()
  const nodes = mod.renderSafe('<p>a<br>b</p><p>c</p>')
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0].tag, 'p')
  const kids = nodes[0].children
  assert.equal(kids.length, 3)
  assert.equal(kids[0], 'a')
  assert.equal(kids[1].tag, 'br')
  assert.deepEqual(kids[1].children, [])
  assert.equal(kids[2], 'b')
  assert.equal(nodes[1].tag, 'p')
  assert.equal(nodes[1].children[0], 'c')
  const hr = mod.renderSafe('<div>x</div><hr><div>y</div>')
  assert.equal(hr.length, 3)
  assert.equal(hr[1].tag, 'hr')
  assert.equal(hr[2].tag, 'div')
})

test('renderSafe：script/iframe 丢弃、危险 href 剥离、https 链接保留', () => {
  const { mod } = loadClient()
  const nodes = mod.renderSafe('<p>正文</p><script>alert(1)</script><iframe src="https://e"></iframe><a href="javascript:alert(1)">坏</a><a href="https://ok.example/a">好</a>')
  const flat = JSON.stringify(nodes)
  assert.ok(!flat.includes('alert(1)'))
  assert.ok(!nodes.some((n) => n.tag === 'script' || n.tag === 'iframe'))
  const links = nodes.filter((n) => n.tag === 'a')
  assert.equal(links.length, 2)
  assert.equal(links[0].props.href, undefined)
  assert.equal(links[1].props.href, 'https://ok.example/a')
  assert.equal(links[1].props.target, '_blank')
  assert.equal(links[1].props.rel, 'noreferrer noopener')
})

test('renderSafe：字面 < 与 img（默认占位 / 代理模式走本地路由）', () => {
  const { mod } = loadClient()
  const t = mod.renderSafe('a < b 与 1<2')
  assert.equal(t.join(''), 'a < b 与 1<2')
  // 默认（未开启图片）：占位文本，绝不产出 <img>（零远程请求）
  const img = mod.renderSafe('<img src="https://x/y.png" alt="图">')
  assert.ok(!JSON.stringify(img).includes('"tag":"img"'), '默认模式不得渲染 img 元素')
  assert.ok(JSON.stringify(img).includes('未开启图片显示'))
  assert.ok(JSON.stringify(img).includes('图'), '占位文本应带 alt')
  // 代理模式：src 重写为本地 /dsh-rss/media 路由（图床看不到客户端 IP）
  const proxied = mod.renderSafe('<img src="https://x/y.png" alt="图">', 'k', { images: true })
  const node = proxied.find((n) => n && n.tag === 'img')
  assert.ok(node, '代理模式应渲染 img')
  assert.equal(node.props.src, '/dsh-rss/media?u=' + encodeURIComponent('https://x/y.png'))
  assert.equal(node.props.alt, '图')
  assert.equal(node.props.loading, 'lazy')
  // 代理模式也绝不直连远程地址
  assert.ok(!JSON.stringify(proxied).includes('"src":"https://'))
  // 危险协议 src：即便代理模式也只占位
  const evil = mod.renderSafe('<img src="javascript:alert(1)" alt="e">', 'k2', { images: true })
  assert.ok(!JSON.stringify(evil).includes('"tag":"img"'))
})

test('decodeEntitiesLite', () => {
  const { mod } = loadClient()
  assert.equal(mod.decodeEntitiesLite('&lt;a&amp;b&gt;'), '<a&b>')
})

// ---------- 组件级行为回归 ----------

const oneArticle = (over = {}) => ({
  id: 'art-1', feedId: 'f1', feedTitle: '源', feedKind: 'standalone', group: '',
  title: '文章甲', url: 'https://example.com/1', publishedMs: 1760000000000, author: null,
  summaryHtml: '<p>摘要</p>', contentHtml: '<p>正文</p>', contentText: '正文',
  read: false, starred: false, excerpt: '摘要', aiResults: [], ...over,
})

function primeCommon(t, { article } = {}) {
  t.respond('/dsh-rss/config', () => ({ ok: true, config: {}, stats: {} }))
  t.respond('/dsh-rss/feeds/list', () => ({ ok: true, feeds: [], stats: {} }))
  t.respond('/dsh-rss/articles', () => ({ ok: true, items: [oneArticle()], total: 1 }))
  t.respond('/dsh-rss/article', () => ({ ok: true, article: article || oneArticle() }))
  const markCalls = []
  t.respond('/dsh-rss/mark', (body) => { markCalls.push(body); return { ok: true } })
  return markCalls
}

test('App：打开未读文章 → 自动标已读且当前视图同步为已读', async () => {
  const t = createHarness()
  const markCalls = primeCommon(t)
  t.loadApp()
  await t.tick()
  t.click('文章甲', false)
  await t.tick()
  assert.ok(markCalls.some((m) => m && m.read === true), '未读文章打开时应调用 mark read:true')
  assert.ok(t.nodesWithText('已读').length, '当前文章视图应显示“已读”徽标（本地状态已同步）')
})

test('App：toggleRead/toggleStar 就地更新当前文章，不重新拉取、不附带自动已读', async () => {
  const t = createHarness()
  const markCalls = primeCommon(t)
  t.loadApp()
  await t.tick()
  t.click('文章甲', false)
  await t.tick()
  const articleCallsBefore = t.fetchLog.filter((f) => f.path === '/dsh-rss/article').length
  // 打开后已自动标为已读 → 第一个切换按钮是“标为未读”
  t.click('标为未读')
  await t.tick()
  assert.equal(t.fetchLog.filter((f) => f.path === '/dsh-rss/article').length, articleCallsBefore, 'toggleRead 不应重新拉取文章')
  assert.deepEqual(markCalls[markCalls.length - 1], { id: 'art-1', read: false })
  t.click('标为已读')
  await t.tick()
  assert.deepEqual(markCalls[markCalls.length - 1], { id: 'art-1', read: true })
  assert.ok(t.nodesWithText('已读').length >= 1, '就地更新后应显示“已读”徽标')
  const starCallsBefore = markCalls.filter((m) => 'starred' in m).length
  t.click('☆ 收藏')
  await t.tick()
  const starCalls = markCalls.filter((m) => 'starred' in m)
  assert.equal(starCalls.length, starCallsBefore + 1)
  assert.ok(!('read' in starCalls[starCalls.length - 1]), '收藏不应附带自动已读')
  assert.ok(t.nodesWithText('★ 取消收藏').length, '就地更新后按钮应为已收藏态')
})

test('App：刷新部分失败/全部失败都逐条展示错误', async () => {
  const t = createHarness()
  primeCommon(t)
  t.respond('/dsh-rss/refresh', () => ({
    ok: true,
    results: [
      { feedId: 'a', title: '源A', ok: true, added: 3, updated: 0, kept: 0 },
      { feedId: 'b', title: '源B', ok: false, error: 'HTTP 500' },
    ],
  }))
  t.loadApp()
  await t.tick()
  t.click('⟳ 刷新')
  await t.tick()
  assert.ok(t.nodesWithText('成功 1/2').length, '部分成功应显示成功/总数')
  assert.ok(t.nodesWithText('源B：HTTP 500').length, '失败订阅的错误应可见')

  const t2 = createHarness()
  primeCommon(t2)
  t2.respond('/dsh-rss/refresh', () => ({
    ok: false,
    results: [{ feedId: 'b', title: '源B', ok: false, error: 'HTTP 503' }],
  }))
  t2.loadApp()
  await t2.tick()
  t2.click('⟳ 刷新')
  await t2.tick()
  assert.ok(t2.nodesWithText('源B：HTTP 503').length, '全部失败时错误仍逐条可见')
})

test('App：FreshRSS 同步部分失败（ok=false）也更新内容并展示逐类失败', async () => {
  const t = createHarness()
  t.respond('/dsh-rss/config', () => ({ ok: true, config: {}, stats: { pendingFresh: { total: 2 } } }))
  t.respond('/dsh-rss/feeds/list', () => ({ ok: true, feeds: [], stats: {} }))
  t.respond('/dsh-rss/articles', () => ({ ok: true, items: [], total: 0 }))
  t.respond('/dsh-rss/freshrss/sync', () => ({
    ok: false,
    feeds: 2, items: 5, pushed: { star: 1 },
    pushFailures: [{ kind: 'read', count: 2, error: 'HTTP 503' }],
  }))
  t.loadApp()
  await t.tick()
  t.click('☁️ FreshRSS')
  await t.tick()
  t.click('⇅ 立即同步')
  await t.tick()
  assert.ok(t.nodesWithText('同步未完全成功').length, '应显示未完全成功错误')
  assert.ok(t.nodesWithText('read×2（HTTP 503）').length, '应显示逐类推送失败详情')
  assert.ok(t.fetchLog.filter((f) => f.path === '/dsh-rss/config').length >= 2, '同步后应重新加载配置统计')
})

test('App：OPML 预览 → 确认导入两段式', async () => {
  const t = createHarness()
  primeCommon(t)
  const imports = []
  t.respond('/dsh-rss/opml/import', (body) => {
    imports.push(body)
    if (body && body.confirm === true) return { ok: true, preview: false, total: 3, toImport: 2, imported: 2, duplicatesInFile: 1, alreadyExisting: 0, skipped: 0, groups: ['技术'], truncated: false }
    return { ok: true, preview: true, total: 3, toImport: 2, duplicatesInFile: 1, alreadyExisting: 0, skipped: 0, groups: ['技术'], sample: [] }
  })
  t.loadApp()
  await t.tick()
  assert.equal(imports.length, 0, '初始不导入')
  const fileInput = t.nodesWithText('导入 OPML').flatMap((n) => n.children || []).find((c) => c && c.tag === 'input')
  assert.ok(fileInput, '应存在文件输入')
  fileInput.props.onChange({ target: { files: [{ text: '<opml>…</opml>' }], value: '' } })
  await t.tick()
  assert.equal(imports.length, 1)
  assert.notEqual(imports[0].confirm, true, '第一次调用是预览')
  assert.ok(t.nodesWithText('将导入 2 / 3 条').length, '预览统计应展示')
  t.click('✓ 确认导入')
  await t.tick()
  assert.equal(imports.length, 2)
  assert.equal(imports[1].confirm, true, '确认后带 confirm:true')
  assert.ok(t.nodesWithText('新增 2/2').length, '导入结果应展示')
  assert.equal(t.nodesWithText('将导入 2 / 3 条').length, 0, '确认条应消失')
})

test('App：FreshRSS needsReset 警告与重置按钮', async () => {
  const t = createHarness()
  t.respond('/dsh-rss/config', () => ({ ok: true, config: { freshrss: { baseUrl: 'x', username: 'y', configured: true, hasApiPassword: true, enabled: true, insecureHttp: false, needsReset: true } }, stats: {} }))
  t.respond('/dsh-rss/feeds/list', () => ({ ok: true, feeds: [], stats: {} }))
  t.respond('/dsh-rss/articles', () => ({ ok: true, items: [], total: 0 }))
  const resets = []
  t.respond('/dsh-rss/freshrss/reset', () => { resets.push(1); return { ok: true, feeds: 3, articles: 10, pending: { total: 0 } } })
  t.loadApp()
  await t.tick()
  t.click('☁️ FreshRSS')
  await t.tick()
  assert.ok(t.nodesWithText('账号已变更').length, '应显示账号变更警告')
  assert.ok(t.nodesWithText('⚠️ 重置 FreshRSS 数据（确认账号变更）').length, '应显示重置按钮')
  t.click('⚠️ 重置 FreshRSS 数据（确认账号变更）')
  await t.tick()
  assert.equal(resets.length, 1)
  assert.ok(t.nodesWithText('已重置 FreshRSS 数据').length)
})

test('App：文章 javascript: 链接不渲染“打开原文”锚点', async () => {
  const t = createHarness()
  primeCommon(t, { article: oneArticle({ url: 'javascript:alert(1)', read: true }) })
  t.loadApp()
  await t.tick()
  t.click('文章甲', false)
  await t.tick()
  assert.equal(t.nodesWithText('打开原文').length, 0, '危险协议原文链接不应渲染')
})
