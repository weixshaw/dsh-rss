import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// ---------- 左侧主导航回归 ----------
//
// 契约依据（本机已装、可运行插件的同构实现，只读核查）：
//  - dsh-slidestudio lib/client.js:336-353 —— registerStandalone：
//      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
//        { name:'sidebar.panellist', id: PANEL, order, label }, EntryIcon))
//      ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key: PANEL }, Page))
//    其 manifest dsh.client.inject 为 []：两座位随壳内置，无需额外注入包。
//  - dsh-context lib/client.js:9345-9410 —— 「Two registrations, one identity」：
//      main 为布局根键控中栏页（「keyed entry switching mounts it on entry and
//      unmounts it on leave, so the page's mount IS its open」）；sidebar.panellist
//      为左栏行（「the shell owns the row (button, label, active state, and the
//      click that selects the panel)」）；两座位自 DSH 0.1.5-rc.1 起随壳提供。
//  - dsh-slidestudio StandaloneSlidesPage：主面板须留 --dsh-frame-top-clearance。
// 本文件按上述宿主行为模拟左栏 shell（选中面板 → 键控挂载 main 页），为源码级回归，
// 不代表真实 GUI 已验证。

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')

function loadClientModule() {
  const loads = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => loads.push(spec) } },
    fetch: async () => ({ json: async () => ({ ok: true }) }),
    URL,
    setTimeout,
    clearTimeout,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: 'client.js' })
  const ReactStub = {
    createElement: (tag, props, ...children) => ({ tag, props: props || {}, children }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
  }
  return loads[0].factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error(`意外的 require: ${name}`)
  })
}

/** 左栏 shell 替身：座位声明、行点击选中面板、键控 main 挂载。 */
function makeShell() {
  const seatCbs = new Map()
  const entries = new Map() // seat -> [{ opts, comp, dispose }]
  let activePanel = null
  const slots = {
    inject: (seat, cb) => {
      seatCbs.set(seat, cb)
      return () => { seatCbs.delete(seat) } // slots.inject 返回的停止函数（注销座位回调）
    },
    register: (opts, comp) => {
      const entry = { opts, comp }
      const list = entries.get(opts.name) || []
      list.push(entry)
      entries.set(opts.name, list)
      return () => { // register 返回的条目注销函数
        const l = entries.get(opts.name) || []
        const i = l.indexOf(entry)
        if (i >= 0) l.splice(i, 1)
      }
    },
  }
  return {
    slots,
    seatCbs,
    entries,
    /** 宿主声明座位 → 我们的回调运行一次，返回条目注销函数。 */
    declareSeat: (seat) => { const cb = seatCbs.get(seat); return cb ? cb() : undefined },
    /** 宿主行的点击语义：选中面板（壳拥有按钮/标签/选中态）。 */
    clickRow: (panelId) => { activePanel = panelId },
    /** 键控切换：仅当面板被选中时中栏挂载对应 main 条目（离开即卸载）。 */
    renderMain: () => {
      const list = entries.get('main') || []
      const hit = list.find((e) => e.opts.key === activePanel)
      return hit ? hit.comp() : null
    },
    activePanel: () => activePanel,
  }
}

function makeCtx(shell) {
  const effectOffs = []
  return {
    ctx: {
      get: (n) => (n === 'slots' ? shell.slots : undefined),
      inject: () => {}, // betterSidebar 嵌套 inject（本文件不测，见 client-runtime.test.js）
      effect: (fn) => { const off = fn(); if (typeof off === 'function') effectOffs.push(off); return off },
    },
    teardown: () => { while (effectOffs.length) effectOffs.pop()() },
  }
}

function setup() {
  const mod = loadClientModule()
  const shell = makeShell()
  const { ctx, teardown } = makeCtx(shell)
  mod.apply(ctx)
  return { mod, shell, teardown }
}

test('导航描述符：main 页与 sidebar.panellist 行共用同一面板身份', () => {
  const { shell } = setup()
  const mainOff = shell.declareSeat('main')
  const rowOff = shell.declareSeat('sidebar.panellist')
  assert.ok(typeof mainOff === 'function' && typeof rowOff === 'function', '回调应返回注销函数')

  const main = (shell.entries.get('main') || [])[0]
  assert.ok(main, 'main 条目应注册')
  assert.equal(main.opts.name, 'main')
  assert.equal(main.opts.key, 'dsh-rss', 'main 页以面板 key 关联')
  assert.equal(typeof main.comp, 'function')

  const row = (shell.entries.get('sidebar.panellist') || [])[0]
  assert.ok(row, 'sidebar.panellist 行应注册')
  assert.equal(row.opts.name, 'sidebar.panellist')
  assert.equal(row.opts.id, 'dsh-rss', '行与 main 页共用同一面板 id')
  assert.equal(typeof row.opts.order, 'number')
  assert.equal(row.opts.label(), 'RSS 阅读')
  assert.equal(typeof row.comp, 'function')
})

test('点击左栏行 → 选中面板 → 中栏键控挂载阅读器（进入挂载/离开卸载）', () => {
  const { shell } = setup()
  shell.declareSeat('main')
  shell.declareSeat('sidebar.panellist')

  assert.equal(shell.renderMain(), null, '未选中面板时中栏不挂载')

  shell.clickRow('dsh-rss') // 宿主行点击 → 选中面板
  const tree = shell.renderMain()
  assert.ok(tree, '选中面板后 main 页应挂载')
  assert.equal(tree.tag, 'div')
  assert.ok(String(tree.props.style.paddingTop).includes('--dsh-frame-top-clearance'),
    '主面板应为桌面窗口铬条留出官方间隙')
  assert.equal(typeof tree.children[0].tag, 'function')
  assert.equal(tree.children[0].tag.name, 'App', '页面内容应为阅读器 App')

  shell.clickRow(null) // 切走 → 键控卸载
  assert.equal(shell.renderMain(), null, '离开面板应卸载页面')
})

test('左栏图标契约：跟随 size、忽略 active、currentColor 跟随主题', () => {
  const { shell } = setup()
  shell.declareSeat('sidebar.panellist')
  const icon = (shell.entries.get('sidebar.panellist') || [])[0].comp

  const el = icon({ size: 20, active: true }) // active 由行自身样式表达，图标不读
  assert.equal(el.tag, 'svg')
  assert.equal(el.props.width, 20)
  assert.equal(el.props.height, 20)
  assert.equal(el.props.stroke, 'currentColor', 'mono 徽记用 currentColor，让宿主行配色生效')

  const fallback = icon({})
  assert.equal(fallback.props.width, 16, '缺省 size 回退 16')
})

test('依赖守卫：座位未声明时回调不运行、不抛错；slots 缺失时直接返回', () => {
  const mod = loadClientModule()
  const shell = makeShell()
  const { ctx } = makeCtx(shell)
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(shell.entries.size, 0, '宿主未声明座位 → 条目缺失而非启动失败')
  // slots 服务本身缺失（理论上宿主必提供；守卫防崩）
  assert.doesNotThrow(() => mod.apply({ get: () => undefined, inject: () => {}, effect: () => () => {} }))
})

test('销毁：模块卸载注销两座位回调；条目注销函数可用且互不影响', () => {
  const { shell, teardown } = setup()
  const mainOff = shell.declareSeat('main')
  const rowOff = shell.declareSeat('sidebar.panellist')
  assert.ok((shell.entries.get('main') || []).length === 1)
  assert.ok((shell.entries.get('sidebar.panellist') || []).length === 1)

  mainOff() // 单条目注销（如宿主侧座位重建）
  assert.equal((shell.entries.get('main') || []).length, 0)
  assert.equal((shell.entries.get('sidebar.panellist') || []).length, 1, '互不影响')

  teardown() // 模块卸载：ctx.effect 持有的两个停止函数运行 → 座位回调注销
  assert.equal(shell.seatCbs.has('main'), false, 'main 座位回调应注销')
  assert.equal(shell.seatCbs.has('sidebar.panellist'), false, 'panellist 座位回调应注销')
  rowOff()
  assert.equal((shell.entries.get('sidebar.panellist') || []).length, 0)
})

test('与既有入口共存：设置入口与 Better Sidebar 嵌套注册不受主导航影响', () => {
  const mod = loadClientModule()
  const shell = makeShell()
  const nested = []
  const { ctx } = makeCtx(shell)
  ctx.inject = (deps, cb) => nested.push({ deps: [...deps], cb })
  mod.apply(ctx)
  assert.ok(shell.seatCbs.has('settings.section'), '设置入口保留')
  assert.ok(shell.seatCbs.has('main') && shell.seatCbs.has('sidebar.panellist'), '主导航两座位就绪')
  assert.equal(nested.length, 1)
  assert.deepEqual(nested[0].deps, ['betterSidebar'], 'Better Sidebar 可选注册保留')
})
