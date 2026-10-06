import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// ---------- 运行时生命周期模拟（Cordis 嵌套 inject 契约） ----------
//
// 本机没有可直接加载的 Cordis 副本（@deepseek-ai/cordis 只在 DSH 安装包 app.asar 内；
// 已核查 ~/.dsh/profiles/** 与 app.asar.unpacked 均无该包；工作令禁止安装依赖），
// 因此按已核实的运行时文档语义实现最小模拟，用于回归 dsh-rss 客户端的可选注册生命周期：
//  - ctx.inject(deps, cb)：服务全部就绪时 cb 运行一次（收到响应式 scope）；任一缺失时
//    scope 销毁（执行 effect disposer）；恢复时重跑 —— 同构用法依据：dshmarket
//    src/client/index.ts:146-161（「NESTED inject on purpose」）、dsh-agent-sync
//    index.mjs:1795-1814（「register routes reactively」）与 dsh-rss host 半
//    index.js:8-10 的用法说明。
//  - scope.get(name)：仅允许解析本 fiber 声明的服务，未声明访问抛
//    `cannot get property "<name>" without inject`（对齐 dsh-better-sidebar
//    src/client/index.tsx:35-49 对 Cordis 守卫的描述）。
//  - scope.effect(fn)：立即执行 fn；fn 返回的注销函数在 scope 销毁时执行
//    （dsh-better-sidebar 全库一致用法）。
//  - registerTab 重复 id 抛错：对齐 dsh-better-sidebar src/client/service.ts:705-723。
// 真实 GUI 行为仍需装机验证（见 README）；本文件是契约级回归，不是实机验证。

class Fiber {
  constructor(runtime, deps, callback) {
    this.runtime = runtime
    this.deps = deps
    this.callback = callback
    this.disposers = []
    this.started = false
    this.disposed = false
  }

  get ready() {
    return this.deps.every((d) => this.runtime.services.has(d))
  }

  sync() {
    if (this.disposed) return
    if (this.ready && !this.started) {
      this.started = true
      this.callback(this.makeScope())
    } else if (!this.ready && this.started) {
      this.destroy()
    }
  }

  makeScope() {
    const fiber = this
    return {
      get(name) {
        if (!fiber.deps.includes(name)) {
          throw new Error(`cannot get property "${name}" without inject`)
        }
        return fiber.runtime.services.get(name)
      },
      effect(fn) {
        const off = fn()
        if (typeof off === 'function') fiber.disposers.push(off)
        return off
      },
    }
  }

  destroy() {
    this.started = false
    for (const off of this.disposers.splice(0)) {
      try { off() } catch { /* 已注销 */ }
    }
  }
}

class Runtime {
  constructor() {
    this.services = new Map()
    this.fibers = new Set()
  }

  define(name, instance) {
    this.services.set(name, instance)
    this.syncAll()
  }

  undefine(name) {
    this.services.delete(name)
    this.syncAll()
  }

  syncAll() {
    for (const fiber of [...this.fibers]) fiber.sync()
  }

  makeRootCtx() {
    const runtime = this
    return {
      get(name) { return runtime.services.get(name) },
      inject(deps, callback) {
        const fiber = new Fiber(runtime, [...deps], callback)
        runtime.fibers.add(fiber)
        fiber.sync()
        return fiber
      },
    }
  }

  disposeAll() {
    for (const fiber of [...this.fibers]) {
      fiber.disposed = true
      fiber.destroy()
    }
    this.fibers.clear()
  }
}

// ---------- 载入客户端模块（与 client.test.js 相同的零构建 vm 装载） ----------

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

function makeSlotsService() {
  const seatCallbacks = new Map()
  const registered = []
  return {
    seatCallbacks,
    registered,
    inject: (seat, cb) => { seatCallbacks.set(seat, cb) },
    register: (opts, comp) => { registered.push({ opts, comp }); return () => {} },
    hasSeat: (seat) => seatCallbacks.has(seat),
    openSeat: (seat) => { const cb = seatCallbacks.get(seat); return cb ? cb() : undefined },
  }
}

function makeSidebarService() {
  const tabs = new Map()
  const calls = []
  return {
    tabs,
    calls,
    registerTab: (descriptor) => {
      if (tabs.has(descriptor.id)) {
        throw new Error(`[dsh-better-sidebar] tab type "${descriptor.id}" already registered`)
      }
      calls.push(descriptor.id)
      tabs.set(descriptor.id, descriptor)
      return () => { if (tabs.get(descriptor.id) === descriptor) tabs.delete(descriptor.id) }
    },
  }
}

// ---------- 生命周期回归 ----------

test('运行时契约：apply 在 slots 就绪后运行，settings.section 立即可用（无需 betterSidebar）', () => {
  const mod = loadClientModule()
  const rt = new Runtime()
  const slots = makeSlotsService()
  rt.define('slots', slots)
  mod.apply(rt.makeRootCtx())
  assert.ok(slots.hasSeat('settings.section'), 'settings.section 座位回调应已挂接')
  assert.ok(slots.hasSeat('main') && slots.hasSeat('sidebar.panellist'), '左侧主导航两座位（main/sidebar.panellist）应已挂接')
  slots.openSeat('settings.section') // 宿主声明座位后回调运行一次（返回注销函数，由 slot 宿主管理）
  const entry = slots.registered.at(-1)
  assert.ok(entry, 'register 应被调用')
  assert.equal(entry.opts.id, 'dsh-rss')
  assert.equal(entry.opts.label(), 'RSS 阅读')
})

test('晚到 provider：betterSidebar 上线后恰好注册一次', () => {
  const mod = loadClientModule()
  const rt = new Runtime()
  const slots = makeSlotsService()
  rt.define('slots', slots)
  mod.apply(rt.makeRootCtx())
  assert.equal(rt.services.has('betterSidebar'), false)

  const bs = makeSidebarService()
  rt.define('betterSidebar', bs) // 服务晚到：apply 之后才提供
  assert.deepEqual(bs.calls, ['dsh-rss:reader'], '应恰好注册一次')
  const tab = bs.tabs.get('dsh-rss:reader')
  assert.ok(tab, 'tab 描述符应在服务注册表中')
  assert.equal(tab.title, 'RSS 阅读')
  assert.equal(tab.single, true)
  const el = tab.component()
  assert.equal(typeof el.tag, 'function')
  assert.equal(el.tag.name, 'App')
})

test('下线/恢复：自动注销再注册，无重复、无残留、settings 入口不受影响', () => {
  const mod = loadClientModule()
  const rt = new Runtime()
  const slots = makeSlotsService()
  rt.define('slots', slots)
  mod.apply(rt.makeRootCtx())

  const bs1 = makeSidebarService()
  rt.define('betterSidebar', bs1)
  assert.equal(bs1.tabs.size, 1)

  rt.undefine('betterSidebar') // 服务下线：effect disposer 自动注销
  assert.equal(bs1.tabs.size, 0, '下线应注销 tab')
  assert.ok(slots.hasSeat('settings.section'), 'betterSidebar 下线不得影响设置入口')

  const bs2 = makeSidebarService() // 服务恢复（新实例、全新注册表）
  rt.define('betterSidebar', bs2)
  assert.deepEqual(bs2.calls, ['dsh-rss:reader'], '恢复后应重新注册恰好一次')
  assert.equal(bs2.tabs.size, 1)
  assert.equal(bs1.tabs.size, 0, '旧实例无残留')
  // 重复 id 防线（对齐 service.ts:705-723）：若生命周期漏注销，第二次注册会在这里之前抛错
  assert.throws(() => bs2.registerTab({ id: 'dsh-rss:reader', title: 'x', component: () => null }), /already registered/)
})

test('客户端销毁：模块卸载时全部注销、不泄漏', () => {
  const mod = loadClientModule()
  const rt = new Runtime()
  const slots = makeSlotsService()
  rt.define('slots', slots)
  mod.apply(rt.makeRootCtx())
  const bs = makeSidebarService()
  rt.define('betterSidebar', bs)
  assert.equal(bs.tabs.size, 1)

  rt.disposeAll() // 模块销毁（卸载/HMR）：由 loader 触发 fiber 销毁
  assert.equal(bs.tabs.size, 0, '销毁应注销 tab，无泄漏')
})

test('未声明访问守卫：scope 只允许解析已声明服务（模拟 Cordis inject 守卫）', () => {
  const rt = new Runtime()
  rt.define('slots', makeSlotsService())
  const bs = makeSidebarService()
  rt.define('betterSidebar', bs)
  let scope = null
  rt.makeRootCtx().inject(['betterSidebar'], (s) => { scope = s })
  assert.ok(scope, '服务就绪时 scope 回调应运行')
  assert.equal(scope.get('betterSidebar'), bs)
  assert.throws(() => scope.get('slots'), /cannot get property "slots" without inject/)
})
