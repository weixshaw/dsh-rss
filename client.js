// dsh-rss —— 浏览器半（DSH Web/Desktop 客户端）
//
// 契约（对齐 dsh-agent-sync client.js 的零构建形态）：
//   window.__ModuleLoader__.load({ id, factory(require){ …; exports.apply = apply; exports.inject = ['slots'] } })
//   左侧主入口（一等面板，与其他插件并排）——「两次注册、同一身份」（契约同构：
//     dsh-slidestudio registerStandalone / dsh-context watchInsightPage，两座位自
//     DSH 0.1.5-rc.1 起随壳内置）：
//     slots.inject('main', () => slots.register({ name:'main', key:'dsh-rss' }, Page))
//     slots.inject('sidebar.panellist', () => slots.register({ name:'sidebar.panellist', id:'dsh-rss', order, label }, Icon))
//   apply(ctx): ctx.get('slots') + slots.inject('settings.section', () => slots.register({…}, Panel))
//   可选 betterSidebar：嵌套 ctx.inject(['betterSidebar'], scope => { scope.effect(() => registerTab(…)) })
//   —— 模块级 inject 只声明 slots：把 betterSidebar 写进模块级声明会让未装 dsh-better-sidebar
//   的宿主上整个客户端模块不激活（「设置 → RSS 阅读」随之消失）；嵌套 inject 则只在服务
//   存在时注册 tab（同构用法：dshmarket src/client/index.ts 的「NESTED inject on purpose」）。
//
// 渲染安全：正文绝不使用 innerHTML/dangerouslySetInnerHTML；
// renderSafe 只用白名单标签构建 React 节点（a 仅允许 http/https 链接），
// 远程图片默认不加载（host 已把 <img> 换成 [图片： …] 文本标记）。
window.__ModuleLoader__.load({
  id: 'dsh-rss',
  factory: function (require) {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var CSS = '' +
      // 布局基座：顶栏 + （分组导航 | 文章列表 | 拖宽手柄 | 阅读栏）。容器查询驱动窄容器自适应。
      '.drss-root{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#1f2328);background:var(--dsw-alias-bg-base,#fff);display:flex;flex-direction:column;height:100%;min-height:0}' +
      '.drss-root *,.drss-root *::before,.drss-root *::after{box-sizing:border-box}' +
      '.drss-shell{flex:1;min-height:0;display:flex;flex-direction:column;position:relative;container-type:inline-size}' +
      '.drss-main{flex:1;min-height:0;display:grid;grid-template-columns:212px 320px 5px minmax(0,1fr)}' +
      // 顶栏
      '.drss-topbar{display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);flex-wrap:wrap;background:var(--dsw-alias-bg-layer-1,#fff)}' +
      '.drss-brand{font-size:14px;font-weight:600;letter-spacing:.2px;white-space:nowrap}' +
      '.drss-scope{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b93a1);border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:999px;padding:1px 9px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.drss-tabs{display:flex;gap:2px;background:color-mix(in srgb,var(--dsw-alias-border-l2,#d9dde3) 16%,transparent);border-radius:9px;padding:2px}' +
      '.drss-tab{font:inherit;font-size:12px;padding:2px 10px;border-radius:7px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;white-space:nowrap}' +
      '.drss-tab:hover{color:var(--dsw-alias-label-primary,#1f2328)}' +
      '.drss-tab.on{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-weight:600;box-shadow:0 1px 2px rgba(15,20,30,.1)}' +
      '.drss-btn{font:inherit;font-size:12px;padding:3px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d9dde3);background:transparent;color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer;white-space:nowrap}' +
      '.drss-btn:hover{border-color:var(--dsw-alias-brand-primary,#4f6ef7);color:var(--dsw-alias-brand-primary,#4f6ef7)}' +
      '.drss-btn:focus-visible,.drss-tab:focus-visible,.drss-item:focus-visible,.drss-nav-row:focus-visible,.drss-pill:focus-visible,.drss-split:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:1px}' +
      '.drss-btn:disabled{opacity:.5;cursor:default}' +
      '.drss-btn.pri{border-color:var(--dsw-alias-brand-primary,#4f6ef7);color:var(--dsw-alias-brand-primary,#4f6ef7)}' +
      '.drss-btn.danger{border-color:var(--dsw-alias-state-error-primary,#dc2626);color:var(--dsw-alias-state-error-primary,#dc2626)}' +
      '.drss-btn.on{background:var(--dsw-alias-brand-primary,#4f6ef7);border-color:var(--dsw-alias-brand-primary,#4f6ef7);color:#fff}' +
      '.drss-in{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#1f2328);background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:8px;padding:3px 10px;min-width:110px}' +
      '.drss-in:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4f6ef7)}' +
      '.drss-in.wide{min-width:220px}' +
      '.drss-pill{font:inherit;font-size:12px;padding:2px 10px;border-radius:999px;border:1px solid transparent;background:color-mix(in srgb,var(--dsw-alias-border-l2,#d9dde3) 18%,transparent);color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer}' +
      '.drss-pill:hover{border-color:var(--dsw-alias-border-l2,#d9dde3)}' +
      '.drss-pill.on{background:var(--dsw-alias-brand-primary,#4f6ef7);color:#fff;font-weight:600}' +
      // 分组导航栏
      '.drss-folders{overflow:auto;border-right:1px solid var(--dsw-alias-border-l1,#e5e7eb);padding:8px 6px;background:var(--dsw-alias-bg-layer-1,#fff)}' +
      '.drss-nav-title{font-size:11px;font-weight:600;letter-spacing:.6px;color:var(--dsw-alias-label-tertiary,#8b93a1);margin:10px 8px 4px;text-transform:uppercase}' +
      '.drss-nav-row{display:flex;align-items:center;gap:6px;width:100%;font:inherit;font-size:12.5px;text-align:left;padding:4px 8px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer}' +
      '.drss-nav-row:hover{background:color-mix(in srgb,var(--dsw-alias-border-l2,#d9dde3) 22%,transparent)}' +
      '.drss-nav-row.on{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6ef7) 12%,transparent);color:var(--dsw-alias-brand-primary,#4f6ef7);font-weight:600}' +
      '.drss-nav-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.drss-nav-count{flex:0 0 auto;font-size:10.5px;min-width:18px;text-align:center;border-radius:999px;padding:0 5px;background:color-mix(in srgb,var(--dsw-alias-border-l2,#d9dde3) 26%,transparent);color:var(--dsw-alias-label-secondary,#6b7280);font-variant-numeric:tabular-nums}' +
      '.drss-nav-count.dim{opacity:.55;font-weight:400}' +
      '.drss-nav-head{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:8px 8px 4px}' +
      '.drss-nav-head .drss-nav-title{margin:0}' +
      '.drss-hide-done{font:inherit;font-size:10.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#d9dde3);background:transparent;color:var(--dsw-alias-label-tertiary,#8b93a1);cursor:pointer;white-space:nowrap}' +
      '.drss-hide-done:hover{border-color:var(--dsw-alias-brand-primary,#4f6ef7);color:var(--dsw-alias-brand-primary,#4f6ef7)}' +
      '.drss-hide-done.on{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6ef7) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6ef7) 35%,transparent);color:var(--dsw-alias-brand-primary,#4f6ef7)}' +
      '.drss-nav-add{display:flex;gap:4px;padding:8px 6px 4px;border-top:1px solid var(--dsw-alias-border-l1,#e5e7eb);margin-top:8px}' +
      '.drss-nav-add .drss-in{min-width:0;flex:1 1 auto;font-size:11.5px;padding:3px 8px}' +
      '.drss-nav-row.on .drss-nav-count{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6ef7) 18%,transparent)}' +
      '.drss-nav-chev{flex:0 0 auto;width:14px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8b93a1);border:none;background:none;cursor:pointer;padding:0;line-height:1}' +
      '.drss-nav-item{display:flex;align-items:center;gap:2px}' +
      '.drss-nav-item .drss-nav-row{flex:1 1 auto;min-width:0}' +
      '.drss-nav-sep{height:1px;background:var(--dsw-alias-border-l1,#e5e7eb);margin:8px 4px}' +
      '.drss-side-foot{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b93a1);padding:8px 8px 2px;line-height:1.7}' +
      // 文章列表栏（qiaomu 式扫描面：顶部 meta 行 + 两行标题 + 两行摘要，发丝线分隔）
      '.drss-list{display:flex;flex-direction:column;min-height:0;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fff);overscroll-behavior:contain}' +
      '.drss-list-bar{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);flex-wrap:wrap;position:sticky;top:0;background:var(--dsw-alias-bg-layer-1,#fff);z-index:2}' +
      '.drss-item{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:10px;align-items:start;width:100%;text-align:left;font:inherit;padding:11px 14px 12px 20px;border:none;background:transparent;cursor:pointer;position:relative}' +
      '.drss-item::after{content:"";position:absolute;left:20px;right:14px;bottom:0;height:1px;background:var(--dsw-alias-border-l1,#eceef1);opacity:.7}' +
      '.drss-item:hover{background:color-mix(in srgb,var(--dsw-alias-border-l2,#d9dde3) 12%,transparent)}' +
      '.drss-item.sel{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6ef7) 8%,transparent);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary,#4f6ef7)}' +
      '.drss-item-meta{grid-column:1 / -1;display:flex;align-items:center;gap:7px;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b93a1);line-height:16px}' +
      '.drss-item-feed{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}' +
      '.drss-item-date{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8b93a1);font-variant-numeric:tabular-nums;white-space:nowrap}' +
      '.drss-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4f6ef7)}' +
      '.drss-star{flex:0 0 auto;font-size:12px;color:var(--dsw-alias-state-warning-primary,#d97706);font-family:inherit;line-height:1}' +
      '.drss-item-title{grid-column:1;margin-top:3px;font-size:13.5px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary,#1f2328);overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}' +
      '.drss-item.read .drss-item-title{font-weight:400;color:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2328) 72%,var(--dsw-alias-bg-layer-1,#fff))}' +
      '.drss-item-sum{grid-column:1;margin-top:3px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b7280);overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}' +
      '.drss-item.read .drss-item-sum{color:var(--dsw-alias-label-tertiary,#8b93a1)}' +
      '.drss-item-thumb{grid-column:2;grid-row:2 / span 2;width:64px;height:64px;border-radius:6px;overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-border-l2,#d9dde3) 40%,transparent);outline:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#d9dde3) 60%,transparent);outline-offset:-1px}' +
      '.drss-item-thumb img{width:100%;height:100%;object-fit:cover;display:block}' +
      '.drss-more{display:block;width:calc(100% - 24px);margin:8px 12px 12px}' +
      '.drss-more-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b93a1);text-align:center;margin:6px 0 10px}' +
      // 列表/阅读栏之间的拖宽手柄（qiaomu 式 col-resize）
      '.drss-split{position:relative;cursor:col-resize;background:transparent;touch-action:none;border:none;padding:0}' +
      '.drss-split::after{content:"";position:absolute;left:-3px;top:0;bottom:0;width:7px}' +
      '.drss-split:hover,.drss-split:focus-visible,.drss-split.drag{background:var(--dsw-alias-border-l2,#d9dde3)}' +
      '.drss-split.drag{background:var(--dsw-alias-brand-primary,#4f6ef7)}' +
      // 阅读栏：sticky 工具栏 + 804px 衬线排版（qiaomu 阅读面）
      '.drss-read{display:flex;flex-direction:column;min-height:0;overflow:auto;background:var(--dsw-alias-bg-base,#fff);overscroll-behavior:contain}' +
      '.drss-read-bar{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:6px;padding:7px 12px;background:var(--dsw-alias-bg-layer-1,#fff);border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);flex-wrap:wrap}' +
      '.drss-read-inner{width:100%;max-width:804px;margin:0 auto;padding:24px clamp(20px,4%,48px) 80px}' +
      '.drss-art-title{font-size:clamp(21px,2.6cqw,28px);font-weight:600;line-height:1.5;letter-spacing:-.01em;margin:10px 0 8px;overflow-wrap:anywhere}' +
      '.drss-art-meta{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a1);display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:18px;padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l1,#eceef1)}' +
      '.drss-badge{font-size:11px;border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:4px;padding:0 6px;color:var(--dsw-alias-label-secondary,#6b7280)}' +
      '.drss-body{font-family:"Songti SC","Noto Serif CJK SC",Georgia,"Times New Roman",serif;font-size:17px;line-height:1.9;white-space:normal;overflow-wrap:anywhere;-webkit-user-select:text;user-select:text}' +
      '.drss-body p{margin:1.1em 0}' +
      '.drss-body h1,.drss-body h2{margin:1.8em 0 .7em;line-height:1.5;font-size:1.3em}' +
      '.drss-body h3,.drss-body h4{margin:1.6em 0 .6em;line-height:1.5;font-size:1.12em}' +
      '.drss-body pre{background:color-mix(in srgb,var(--dsw-alias-border-l2,#d9dde3) 16%,transparent);border-radius:8px;padding:14px 16px;overflow:auto;font-size:13px;line-height:1.6;margin:1.2em 0}' +
      '.drss-body code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85em}' +
      '.drss-body blockquote{border-left:3px solid var(--dsw-alias-border-l2,#d9dde3);margin:1.4em 0;padding:10px 16px;color:var(--dsw-alias-label-secondary,#6b7280);background:color-mix(in srgb,var(--dsw-alias-border-l2,#d9dde3) 8%,transparent);border-radius:0 8px 8px 0}' +
      '.drss-body a{color:var(--dsw-alias-brand-primary,#4f6ef7);text-underline-offset:3px}' +
      '.drss-body ul,.drss-body ol{padding-left:24px;margin:1em 0}' +
      '.drss-body table{display:block;overflow:auto;border-collapse:collapse;max-width:100%;margin:1.2em 0}' +
      '.drss-body td,.drss-body th{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);padding:6px 10px}' +
      '.drss-art-img{display:block;max-width:100%;height:auto;border-radius:6px;margin:1.2em auto}' +
      '.drss-img-ph{display:inline-block;margin:.4em 0;padding:2px 10px;font-size:12.5px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif;color:var(--dsw-alias-label-tertiary,#8b93a1);border:1px dashed var(--dsw-alias-border-l2,#d9dde3);border-radius:6px}' +
      '.drss-media-hint{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 16px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-border-l2,#d9dde3) 8%,transparent)}' +
      '.drss-audio{display:block;width:100%;margin:0 0 16px}' +
      '.drss-video{display:block;width:100%;aspect-ratio:16/9;min-height:200px;border:0;border-radius:8px;background:#000;margin:0 0 18px}' +
      '.drss-ai{border:1px dashed var(--dsw-alias-border-l2,#d9dde3);border-radius:10px;padding:10px 12px;margin:12px 0;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6ef7) 4%,transparent);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif}' +
      '.drss-ai-h{font-size:12px;font-weight:600;color:var(--dsw-alias-brand-primary,#4f6ef7);display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
      '.drss-ai-b{white-space:pre-wrap;font-size:13px;margin-top:6px}' +
      // 管理视图 / 表单 / 反馈
      '.drss-view{flex:1;min-height:0;overflow:auto;padding:14px 18px 40px}' +
      '.drss-view-inner{max-width:860px;margin:0 auto}' +
      '.drss-view-head{display:flex;align-items:center;gap:8px;margin:4px 0 10px;flex-wrap:wrap}' +
      '.drss-view-title{font-size:15px;font-weight:600}' +
      '.drss-view-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a1)}' +
      '.drss-sec{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;padding:10px 12px;margin:10px 0}' +
      '.drss-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:6px 0}' +
      '.drss-label{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}' +
      '.drss-kv{display:flex;gap:10px;font-size:12px;margin:3px 0}' +
      '.drss-kv b{flex:0 0 110px;color:var(--dsw-alias-label-tertiary,#8b93a1);font-weight:500}' +
      '.drss-msg{font-size:12px;margin:0;padding:7px 12px;white-space:pre-wrap;color:var(--dsw-alias-label-secondary,#6b7280);background:var(--dsw-alias-bg-layer-1,#fff);border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb)}' +
      '.drss-err{color:var(--dsw-alias-state-error-primary,#dc2626)}' +
      '.drss-empty{color:var(--dsw-alias-label-tertiary,#8b93a1);font-style:italic;padding:18px 14px;font-size:12px;text-align:center}' +
      '.drss-loading{color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:12px;padding:14px;text-align:center}' +
      '.drss-warn{border:1px solid var(--dsw-alias-state-warning-primary,#d97706);color:var(--dsw-alias-state-warning-primary,#d97706);border-radius:8px;padding:6px 10px;font-size:12px;margin:8px 0}' +
      // 窄容器（Better Sidebar tab / 移动）：单栏 + 抽屉式分组栏；打开文章时列表让位。
      // 注意：抽屉 .drss-folders 的绝对定位锚点（.drss-shell{position:relative}）必须放在上面的
      // 基础规则里——元素永远不会匹配「自身」所在的容器查询，把 .drss-shell 规则写进本块是无效死代码，
      // 会导致抽屉锚到 shell 之外的宿主容器（main/设置/右侧栏三种入口下都要求锚在 shell 内）。
      '.drss-font-ctl{display:inline-flex;align-items:center;gap:2px}' +
      '.drss-font-ctl .drss-btn{padding:3px 7px}' +
      '.drss-full-note{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a1);border:1px dashed var(--dsw-alias-border-l2,#d9dde3);border-radius:8px;padding:5px 10px;margin:0 0 12px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif}' +
      '.drss-folders-toggle{display:inline-block}' +
      '.drss-folders-btn{display:none}' +
      '@container (max-width: 920px){' +
      '.drss-main{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}' +
      '.drss-folders-toggle{display:none}' +
      '.drss-split{display:none}' +
      '.drss-folders{position:absolute;inset:0 auto 0 0;width:230px;z-index:30;box-shadow:8px 0 24px rgba(15,20,30,.16);display:none}' +
      '.drss-root[data-folders="open"] .drss-folders{display:block}' +
      '.drss-folders-btn{display:inline-block}' +
      '.drss-list{border-right:none}' +
      '.drss-root[data-art="1"] .drss-list{display:none}' +
      '.drss-root[data-art="0"] .drss-read{display:none}' +
      '.drss-read-inner{padding:18px 16px 60px}' +
      '.drss-body{font-size:16px}' +
      '}'

    var styleInjected = false
    function ensureStyles() {
      if (styleInjected) return
      styleInjected = true
      try {
        var style = document.createElement('style')
        style.dataset.plugin = 'dsh-rss'
        style.textContent = CSS
        document.head.appendChild(style)
      } catch (e) { /* 非 DOM 环境（测试） */ }
    }

    // ---------- Host API ----------

    // 与 package.json 版本保持一致（scripts/check.js 有一致性门禁）。
    // 用于「客户端新、宿主旧」检测：本地路径安装不会热更新宿主端，硬刷新后客户端先行
    // 生效，此时新路由（图片代理等）在旧宿主上 404——与其无声失败，不如显式提示重启。
    var CLIENT_VERSION = '0.6.1'

    /**
     * 响应鲁棒解析：先取文本再 JSON.parse。宿主链路上任何环节掐断响应
     * （慢请求被客户端层中断、代理返回 HTML 错误页等）时，返回可读的
     * {ok:false,error} 而不是抛 "Unexpected end of JSON input" 这类天书。
     */
    function parseRes(res) {
      return Promise.resolve()
        .then(function () {
          if (res && typeof res.text === 'function') return res.text()
          if (res && typeof res.json === 'function') return res.json()
          return null
        })
        .then(function (body) {
          if (body == null) return { ok: false, error: '宿主无响应' }
          if (typeof body !== 'string') return body
          if (!body.trim()) return { ok: false, error: '宿主响应为空：请求可能因超时被中断（慢源可稍后重试）' }
          try {
            return JSON.parse(body)
          } catch (e) {
            return { ok: false, error: '宿主响应不是 JSON（连接可能被中断或网关返回了错误页）：' + body.slice(0, 120) }
          }
        })
        .catch(function (e) {
          return { ok: false, error: '请求失败或连接中断：' + (e && e.message) }
        })
    }

    function call(method, args) {
      return fetch('/dsh-rss/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-rss': '1' },
        body: JSON.stringify(args || {}),
      }).then(parseRes)
    }

    function callGet(method) {
      return fetch('/dsh-rss/' + method, {
        method: 'GET',
        headers: { 'x-dsh-rss': '1' },
      }).then(parseRes)
    }

    // ---------- 本地 UI 状态持久化（localStorage 可用才启用；任何异常一律忽略） ----------

    var UI_LS_KEY = 'dsh-rss:ui:v1'

    function readSavedUi() {
      try {
        if (typeof localStorage === 'undefined' || !localStorage) return null
        var raw = localStorage.getItem(UI_LS_KEY)
        if (!raw) return null
        var v = JSON.parse(raw)
        return v && typeof v === 'object' ? v : null
      } catch (e) { return null }
    }

    function saveUiState(patch) {
      try {
        if (typeof localStorage === 'undefined' || !localStorage) return
        localStorage.setItem(UI_LS_KEY, JSON.stringify(Object.assign(readSavedUi() || {}, patch)))
      } catch (e) { /* 配额/隐私模式：持久化失败不影响使用 */ }
    }

    /** 校验恢复的作用域（防注入任意对象；不合法一律回落「全部」）。 */
    function validSavedScope(v) {
      if (!v || typeof v !== 'object') return { kind: 'all' }
      if (v.kind === 'feed') return typeof v.id === 'string' && v.id ? { kind: 'feed', id: v.id } : { kind: 'all' }
      if (v.kind === 'group') return typeof v.path === 'string' && v.path ? { kind: 'group', path: v.path } : { kind: 'all' }
      if (v.kind === 'ungrouped') return { kind: 'ungrouped' }
      return { kind: 'all' }
    }

    // ---------- 安全富文本渲染（白名单 → React 节点，绝无 innerHTML） ----------

    var ALLOWED = {
      p: 'p', br: 'br', hr: 'hr', a: 'a', b: 'b', strong: 'strong', i: 'i', em: 'em',
      u: 'u', s: 's', del: 'del', code: 'code', pre: 'pre', blockquote: 'blockquote',
      ul: 'ul', ol: 'ol', li: 'li', h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
      span: 'span', div: 'div', table: 'table', thead: 'thead', tbody: 'tbody', tr: 'tr', th: 'th', td: 'td',
    }
    // 危险元素：整块跳过（含其子内容），与 host 侧清理双保险
    var DROP_RE = { script: 1, style: 1, iframe: 1, object: 1, embed: 1, noscript: 1, svg: 1, math: 1, form: 1, link: 1, meta: 1, base: 1, frame: 1, applet: 1, template: 1 }

    function decodeEntitiesLite(s) {
      return String(s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    }

    function safeHref(raw) {
      var s = String(raw || '').trim()
      if (/^https?:\/\//i.test(s)) return s
      return null
    }

    // ---------- 媒体辅助（播客音频 / 视频嵌入 / 列表缩略图首图） ----------

    /** 播客 enclosure：type 为 audio/* 或常见音频扩展；只认 http/https。 */
    function audioEnclosureOf(a) {
      if (!a || !a.enclosureUrl) return null
      var src = safeHref(a.enclosureUrl)
      if (!src) return null
      var t = String(a.enclosureType || '').toLowerCase()
      if (t) return t.indexOf('audio/') === 0 ? src : null
      return /\.(mp3|m4a|ogg|oga|wav|aac|opus|flac)(\?|#|$)/i.test(src) ? src : null
    }

    /** YouTube / B 站链接 → 官方嵌入播放器地址（qiaomu 同款白名单；其余站点一律 null）。 */
    function videoEmbedOf(link) {
      var v = safeHref(link)
      if (!v) return null
      var u
      try { u = new URL(v) } catch (e) { return null }
      var host = u.hostname.toLowerCase()
      var yt = null
      if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
        yt = u.pathname === '/watch' ? u.searchParams.get('v') : (u.pathname.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})\/?$/) || [])[1]
      } else if (host === 'youtu.be' || host === 'www.youtu.be') {
        yt = u.pathname.slice(1)
      }
      if (yt && /^[A-Za-z0-9_-]{11}$/.test(yt)) return `https://www.youtube.com/embed/${yt}?autoplay=0&playsinline=1`
      if (host === 'bilibili.com' || host === 'www.bilibili.com' || host === 'm.bilibili.com') {
        var bv = u.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/)
        if (!bv) return null
        var p = parseInt(u.searchParams.get('p') || '1', 10)
        return `https://player.bilibili.com/player.html?isOutside=true&bvid=${bv[1]}&p=${p > 0 ? p : 1}&autoplay=0&high_quality=1&danmaku=0`
      }
      return null
    }

    /** 文章里的第一张远程图片（已入库的裸 <img src="http…">；用于列表缩略图）。 */
    function firstImgOf(html) {
      var m = /<img\s[^>]*src="(https?:[^"]+)"/i.exec(String(html || ''))
      return m ? m[1] : null
    }

    var RENDER_NODE_CAP = 4000

    /**
     * 把（host 已清理过的）文章 HTML 渲染为 React 节点数组。
     * 白名单之外的一切标签按“透明容器/丢弃属性”处理；文本经 React 自动转义。
     * opts.images=true（「图片代理」开启）时：<img> 的 http/https src 重写为本地代理路由
     * /dsh-rss/media?u=…（远端图床看不到本机 IP）；否则一律渲染为占位文本，绝不发请求。
     */
    function renderSafe(html, keyBase, opts) {
      var images = !!(opts && opts.images)
      var src = String(html || '')
      var nodes = []
      var count = 0
      var key = keyBase || 'n'

      function textNode(t, k) {
        var s = decodeEntitiesLite(t)
        if (!s) return null
        return s
      }

      // 迭代式解析：<tag attr>…</tag>；未知标签只保留其子内容
      function parseSegment(str, base, depth) {
        var out = []
        var i = 0
        var pending = '' // 待 flush 的纯文本
        function flush() {
          if (pending) {
            var t = textNode(pending)
            if (t) out.push(t)
            pending = ''
          }
        }
        while (i < str.length && count < RENDER_NODE_CAP) {
          var lt = str.indexOf('<', i)
          if (lt < 0) { pending += str.slice(i); break }
          pending += str.slice(i, lt)
          var m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/.exec(str.slice(lt))
          if (!m) {
            // 不是标签：按字面文本处理
            pending += '<'
            i = lt + 1
            continue
          }
          var tagRaw = m[1].toLowerCase()
          var attrs = m[2] || ''
          var selfClose = m[3] === '/' || tagRaw === 'br' || tagRaw === 'hr' || tagRaw === 'img'
          var consumed = m[0].length
          if (tagRaw === 'img') {
            // 入库侧已重建为只含校验过的 src/alt；这里再独立校验一次（防绕过/旧缓存）。
            // 代理模式：src 指向本地 /dsh-rss/media 路由；否则只渲染占位文本，零网络请求。
            var sm = /src\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
            var dm = /data-src\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
            var am = /alt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
            var imgSrc = safeHref((sm && (sm[1] || sm[2])) || (dm && (dm[1] || dm[2])) || '')
            var imgAlt = decodeEntitiesLite((am && (am[1] || am[2])) || '')
            flush()
            count++
            if (imgSrc && images) {
              out.push(h('img', {
                key: `${base}-i${count}`, className: 'drss-art-img', loading: 'lazy',
                src: '/dsh-rss/media?u=' + encodeURIComponent(imgSrc), alt: imgAlt,
              }))
            } else {
              out.push(h('span', { key: `${base}-i${count}`, className: 'drss-img-ph' },
                (imgAlt ? `［图片：${imgAlt}｜` : '［图片') + '未开启图片显示，打开原文可查看］'))
            }
            i = lt + consumed
            continue
          }
          if (DROP_RE[tagRaw]) {
            // 危险元素：跳过整个块（含子内容）
            var dropClose = str.indexOf(`</${tagRaw}`, lt + consumed)
            var dropGt = dropClose < 0 ? str.length : str.indexOf('>', dropClose)
            i = dropGt < 0 ? str.length : dropGt + 1
            continue
          }
          if (!ALLOWED[tagRaw]) {
            // 未知标签：开标签跳过（保留子内容）；闭标签跳过
            i = lt + consumed
            continue
          }
          var closing = str.slice(lt, lt + 2) === '</'
          if (closing) {
            flush()
            i = lt + consumed
            continue
          }
          if (selfClose) {
            // 自闭合/空元素（<br>、<hr>、<x/>）：输出空元素，不吞后续兄弟节点
            flush()
            count++
            out.push(h(tagRaw, { key: `${base}-v${count}` }))
            i = lt + consumed
            continue
          }
          // 开标签：找配对闭标签（同类标签不嵌套于正文，忽略嵌套误差）
          var closeIdx = str.indexOf(`</${tagRaw}`, lt + consumed)
          var inner
          var after
          if (closeIdx < 0) {
            inner = str.slice(lt + consumed)
            after = str.length
          } else {
            inner = str.slice(lt + consumed, closeIdx)
            var gt = str.indexOf('>', closeIdx)
            after = gt < 0 ? str.length : gt + 1
          }
          flush()
          count++
          var props = { key: `${base}-e${count}` }
          if (tagRaw === 'a') {
            var hm = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
            var href = safeHref(hm ? (hm[1] || hm[2] || '') : '')
            if (href) {
              props.href = href
              props.target = '_blank'
              props.rel = 'noreferrer noopener'
            }
          }
          if (depth < 24 && inner) {
            out.push(h(tagRaw, props, ...parseSegment(inner, `${base}-e${count}`, depth + 1)))
          } else {
            out.push(h(tagRaw, props, inner ? String(inner).replace(/<[^>]+>/g, '') : ''))
          }
          i = after
        }
        flush()
        return out
      }

      nodes = parseSegment(src, key, 0)
      return nodes
    }

    // ---------- UI 组件 ----------

    function fmtDate(ms) {
      if (!ms) return ''
      try {
        var d = new Date(ms)
        var p = function (n) { return (n < 10 ? '0' : '') + n }
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
      } catch (e) { return '' }
    }

    /** 列表用相对时间（刚刚/N 分钟前/N 小时前/N 天前）；一周外或未来时间回绝对时间。 */
    function relTime(ms) {
      if (!ms) return ''
      var diff = Date.now() - ms
      if (diff < 0 || diff >= 7 * 24 * 3600 * 1000) return fmtDate(ms)
      if (diff < 60000) return '刚刚'
      if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
      if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
      return `${Math.floor(diff / 86400000)} 天前`
    }

    // ---------- 分组导航（真实分类：feed.group 路径 'A/B' + 显式「未分组」桶） ----------
    // 导航层统一使用「规范化路径」（段 trim + 去空段），请求层永远下发订阅里存的
    // **原始分组串**（host 按原始串精确匹配）——避免「显示 技术/AI、查询却匹配不上」。

    function groupSegments(group) {
      return String(group || '').split('/').map(function (s) { return s.trim() }).filter(Boolean)
    }

    /** 规范化路径：' 技术 / AI ' → '技术/AI'；空/纯空白 → ''（未分组）。 */
    function normGroupPath(group) {
      return groupSegments(group).join('/')
    }

    /** 由订阅列表推导分组树：[{path,label,children,feeds}]；path 为规范化路径
     *  （含原始串仅空白差异的订阅合并到同一节点），按实际存在的分组推导，不发明分类。 */
    function buildGroupTree(feeds) {
      var root = { children: new Map(), feeds: [] }
      for (var i = 0; i < feeds.length; i++) {
        var f = feeds[i]
        var segs = groupSegments(f.group)
        if (!segs.length) continue
        var node = root
        var path = ''
        for (var j = 0; j < segs.length; j++) {
          path = path ? `${path}/${segs[j]}` : segs[j]
          if (!node.children.has(path)) node.children.set(path, { path: path, label: segs[j], children: new Map(), feeds: [] })
          node = node.children.get(path)
        }
        node.feeds.push(f)
      }
      var toSorted = function (m) {
        return Array.from(m.values()).map(function (n) { return { path: n.path, label: n.label, children: toSorted(n.children), feeds: n.feeds } })
          .sort(function (a, b) { return a.label.localeCompare(b.label, 'zh-Hans-CN') })
      }
      return toSorted(root.children)
    }

    /** 规范化路径下的原始分组串集合（含自身与子路径）：选中分组 = 明确的子树作用域。
     *  返回原始串（可能为空数组 = 该分组已不存在任何订阅 → 显式空作用域，绝不回退全部）。 */
    function groupsUnderPath(feeds, path) {
      var target = normGroupPath(path)
      var prefix = `${target}/`
      var set = new Set()
      for (var i = 0; i < feeds.length; i++) {
        var g = String(feeds[i].group || '')
        var ng = normGroupPath(g)
        if (ng === target || ng.lastIndexOf(prefix, 0) === 0) set.add(g)
      }
      return Array.from(set)
    }

    /** 未分组桶的原始分组串集合：规范化为空的全部原始串（''、' ' 等）。 */
    function ungroupedGroups(feeds) {
      var set = new Set([''])
      for (var i = 0; i < feeds.length; i++) {
        if (!normGroupPath(feeds[i].group)) set.add(String(feeds[i].group || ''))
      }
      return Array.from(set)
    }

    function App(props) {
      var S = React.useState
      var st = {}
      function use(key, init) { var pair = S(init); st['set_' + key] = pair[1]; return pair[0] }

      // settings 模式（设置 → RSS 阅读 入口）：只渲染管理/连接配置分区，
      // 不含阅读工作台；也不读写浏览上下文持久化（不污染阅读面板的状态）。
      var settingsMode = Boolean(props && props.mode === 'settings')

      var PAGE = 30
      var useRefFn = React.useRef || function (v) { return { current: typeof v === 'function' ? v() : v } }

      function clampNum(v, min, max, fallback) {
        var n = Number(v)
        if (!isFinite(n)) return fallback
        return Math.min(max, Math.max(min, Math.round(n)))
      }

      // 首渲染时读取一次持久化的 UI 状态（面板挂载即恢复上次浏览上下文：
      // 作用域/筛选/搜索/视图/分组展开态/自动刷新开关/列表栏宽度）。
      var savedUiRef = useRefFn(null)
      if (!savedUiRef.current) savedUiRef.current = readSavedUi() || {}
      var sv = savedUiRef.current

      // 视图与作用域（阅读工作台 vs 管理/连接页清晰分离）
      var view = use('view', settingsMode ? 'manage' : (['read', 'manage', 'freshrss', 'ai'].indexOf(sv.view) >= 0 ? sv.view : 'read')) // read | manage | freshrss | ai
      var scope = use('scope', validSavedScope(sv.scope)) // {kind:'all'|'group'|'ungrouped'|'feed', id?, path?}
      var scopeKey = JSON.stringify(scope)
      var expanded = use('expanded', sv.expanded && typeof sv.expanded === 'object' ? sv.expanded : {}) // 分组路径 -> 是否展开
      var listW = use('listW', clampNum(sv.listW, 240, 560, 320)) // 列表栏宽度（拖拽手柄调整）
      var foldersHidden = use('foldersHidden', Boolean(sv.foldersHidden)) // 桌面态收起订阅分组栏
      var hideDone = use('hideDone', sv.hideDone === undefined ? true : Boolean(sv.hideDone)) // 隐藏已读完的订阅（默认开）
      var quickUrl = use('quickUrl', '') // 订阅栏快速添加：RSS/Atom 地址
      var focusRead = use('focusRead', Boolean(sv.focusRead)) // 专注模式：打开文章时收起列表、全宽阅读
      var readFont = use('readFont', clampNum(sv.readFont, 14, 22, 17)) // 正文字号
      var fullHtml = use('fullHtml', null) // 「抓取全文」的临时正文（不落盘；切文章即清）
      var fullBusy = use('fullBusy', false)
      var foldersOpen = use('foldersOpen', false) // 窄容器的分组抽屉（瞬时态，不持久化）

      var cfg = use('cfg', null)
      var feeds = use('feeds', [])
      var feedsReady = use('feedsReady', false) // 订阅列表是否已加载（分组作用域展开依赖它）
      var stats = use('stats', null)
      var counts = use('counts', null) // feedId -> {total,unread,starred}：host 返回的真实计数；缺失则不显示
      var list = use('list', { items: [], total: 0, loading: false })
      var article = use('article', null)
      var msg = use('msg', '')
      var err = use('err', '')
      var busy = use('busy', '')
      var aiText = use('aiText', '')
      var aiBusy = use('aiBusy', '')
      var question = use('question', '')
      var frBase = use('frBase', '')
      var frUser = use('frUser', '')
      var frPass = use('frPass', '')
      var aiBase = use('aiBase', '')
      var aiModel = use('aiModel', '')
      var aiKey = use('aiKey', '')
      var aiEnabled = use('aiEnabled', false)
      var addUrl = use('addUrl', '')
      var addTitle = use('addTitle', '')
      var addGroup = use('addGroup', '')
      var lastSync = use('lastSync', null)
      var pendingImport = use('pendingImport', null)
      var filter = use('filter', ['all', 'unread', 'starred'].indexOf(sv.filter) >= 0 ? sv.filter : 'all')
      var search = use('search', typeof sv.search === 'string' ? sv.search : '')
      var autoRefresh = use('autoRefresh', Boolean(sv.autoRefresh)) // 每 10 分钟自动刷新（仅阅读页挂载时）
      var hostVersion = use('hostVersion', null) // 宿主侧插件版本（ping 探测）
      var verHintClosed = use('verHintClosed', false) // 版本不一致提示条的手动关闭（仅本次挂载）
      var audioOpen = use('audioOpen', null) // 已点击加载音频的文章 id（点击前零网络请求）
      var videoOpen = use('videoOpen', null) // 已点击加载视频嵌入的文章 id

      // 过期响应守卫：作用域/筛选/选中变化**立即**递增序号，旧请求（含防抖窗口内、
      // mark/AI 等异步完成回调）的响应一律按最新序号校验后落地。
      var seq = useRefFn({ list: 0, article: 0 })
      var searchRef = useRefFn(null)
      var feedsReadyRef = useRefFn(false) // 自动刷新等异步回调用（避免闭包读到过期 state）
      // 最新状态快照：异步完成回调（mark/AI/刷新列表）读取这里，避免旧闭包把过期参数写回。
      var cur = useRefFn({})
      cur.current = { scope: scope, scopeKey: scopeKey, filter: filter, search: search, list: list, article: article, feeds: feeds, counts: counts, cfg: cfg }

      var notify = function (m) { st.set_err(''); st.set_msg(m) }
      var failm = function (m) { st.set_msg(''); st.set_err(String(m || '操作失败')) }

      /** 确认写成功后调整未读计数：函数式更新（避免并发读时旧 counts 闭包互相覆盖）。 */
      function adjustUnread(feedId, delta) {
        st.set_counts(function (prev) {
          if (!prev || !prev[feedId]) return prev
          var row = prev[feedId]
          var next = Object.assign({}, prev)
          next[feedId] = Object.assign({}, row, { unread: Math.max(0, (row.unread || 0) + delta) })
          return next
        })
      }

      function loadConfig() {
        return callGet('config').then(function (r) {
          if (r && r.ok) {
            var c = r.config
            st.set_cfg(c)
            st.set_frBase(c.freshrss ? c.freshrss.baseUrl : '')
            st.set_frUser(c.freshrss ? c.freshrss.username : '')
            st.set_aiBase(c.ai ? c.ai.baseUrl : '')
            st.set_aiModel(c.ai ? c.ai.model : '')
            st.set_aiEnabled(c.ai ? Boolean(c.ai.enabled) : false)
            st.set_stats(r.stats)
          } else failm(r && r.error)
        }).catch(function (e) { failm(e && e.message) })
      }

      /** 订阅列表落地后再按新列表重查文章（分组作用域展开依赖 feeds；并发下不得用旧列表建查询体）。 */
      function reloadAfterFeeds() {
        return Promise.resolve(loadFeeds()).then(function () {
          loadArticles({ reset: true, keepPages: true })
        }).catch(function () { /* loadFeeds 已自报错误 */ })
      }

      function loadFeeds() {
        return call('feeds/list').then(function (r) {
          feedsReadyRef.current = true
          st.set_feedsReady(true)
          if (r && r.ok) {
            st.set_feeds(r.feeds)
            st.set_stats(r.stats)
            if (r.counts && typeof r.counts === 'object') st.set_counts(r.counts)
          } else failm(r && r.error)
        }).catch(function (e) {
          feedsReadyRef.current = true
          st.set_feedsReady(true)
          failm(e && e.message)
        })
      }

      /** 当前作用域 → 文章查询/批量操作参数（读 cur 快照，异步回调里也用最新值）。
       *  group=子树原始分组串（可能为空数组=显式空作用域）；ungrouped=规范化为空的全部原始串。 */
      function scopeParams() {
        var s = cur.current.scope || { kind: 'all' }
        var fs0 = cur.current.feeds || []
        if (s.kind === 'feed') return { feedId: s.id }
        if (s.kind === 'group') return { groups: groupsUnderPath(fs0, s.path) }
        if (s.kind === 'ungrouped') return { groups: ungroupedGroups(fs0) }
        return {}
      }

      function scopeLabel() {
        var s = cur.current.scope || { kind: 'all' }
        var fs0 = cur.current.feeds || []
        if (s.kind === 'feed') {
          var f = fs0.filter(function (x) { return x.id === s.id })[0]
          return `订阅「${f ? f.title : ''}」`
        }
        if (s.kind === 'group') return `分组「${s.path}」`
        if (s.kind === 'ungrouped') return '「未分组」'
        return '全部订阅'
      }

      function loadArticles(opts) {
        opts = opts || {}
        var mySeq = ++seq.current.list
        var prevList = cur.current.list || { items: [], total: 0, loading: false }
        // 刷新已有列表（读/标完成后）：保留用户已加载的页数，而不是塌缩回第一页。
        // 后端单次上限 100 条：已加载超过 100 条时按 ≤100/页多次拉取补齐。
        var keep = opts.keepPages ? Math.max(PAGE, prevList.items.length) : PAGE
        // 请求期间保留现有内容并禁用「加载更多」（追加/刷新失败也不丢已加载列表）；
        // 只有普通 reset（作用域/筛选/搜索变化）才清空旧内容——旧作用域条目不得残留。
        st.set_list(opts.reset && !(opts.keepPages && prevList.items.length)
          ? { items: [], total: 0, loading: true }
          : { items: prevList.items, total: prevList.total, loading: true })
        var step = function (offset, remaining, acc) {
          var now = cur.current
          var body = Object.assign({}, scopeParams(), {
            filter: now.filter,
            limit: Math.min(100, remaining > 0 ? remaining : PAGE),
            offset: offset,
          })
          if (now.search) body.search = now.search
          return call('articles', body).then(function (r) {
            if (seq.current.list !== mySeq) return // 过期响应（作用域/筛选/选中已变）：丢弃
            if (r && r.ok) {
              var items = acc.concat(r.items || [])
              var total = r.total || 0
              if (r.items && r.items.length && items.length < keep && items.length < total) {
                return step(items.length, keep - items.length, items) // 补齐剩余已加载页
              }
              st.set_list({ items: items, total: total, loading: false })
            } else {
              // 失败：保留现有列表（刷新/追加失败都不丢已加载内容），只清 loading 并报错
              st.set_list(function (prev) { return { items: prev.items, total: prev.total, loading: false } })
              failm(r && r.error)
            }
          }).catch(function (e) {
            if (seq.current.list !== mySeq) return
            st.set_list(function (prev) { return { items: prev.items, total: prev.total, loading: false } })
            failm(e && e.message)
          })
        }
        return step(opts.reset ? 0 : prevList.items.length, keep - (opts.reset ? 0 : prevList.items.length), opts.reset ? [] : prevList.items)
      }

      React.useEffect(function () { loadConfig(); loadFeeds(); pingHost() }, [])

      /** 探测宿主侧插件版本：客户端（硬刷新即生效）与宿主（需重启 DSH）可能不同步，
       *  版本不一致时新路由/新行为会无声失败——显式提示重启而不是让用户猜。 */
      function pingHost() {
        callGet('ping').then(function (r) {
          if (r && r.ok && r.version) st.set_hostVersion(String(r.version))
        }).catch(function () { /* 宿主不可达有别的错误路径 */ })
      }
      React.useEffect(function () {
        // 订阅列表就绪前不发列表查询：恢复的分组作用域要靠 feeds 展开子树分组串，
        // feeds 未到时会退化成 groups:[] 的显式空作用域（0 结果）且无人重查。
        if (!feedsReady) return undefined
        // 依赖一变就立即作废在途请求（不等防抖结束），防抖窗口内迟到的旧响应无法落地
        seq.current.list++
        st.set_list(function (prev) { return { items: prev.items, total: prev.total, loading: true } })
        var t = setTimeout(function () { loadArticles({ reset: true }) }, search ? 250 : 0) // 新查询：回到第一页
        return function () { clearTimeout(t) }
      }, [feedsReady, scopeKey, filter, search])

      // UI 状态持久化：作用域/筛选/搜索/视图/分组展开态/自动刷新开关/列表栏宽度变化即写入
      // localStorage，面板重新挂载（切换面板/刷新页面）时恢复上次浏览上下文。
      // settings 模式不写：设置面板的视图切换不得污染阅读面板的浏览状态。
      React.useEffect(function () {
        if (settingsMode) return
        saveUiState({ view: view, scope: scope, expanded: expanded, filter: filter, search: search, autoRefresh: autoRefresh, listW: listW, foldersHidden: foldersHidden, focusRead: focusRead, readFont: readFont, hideDone: hideDone })
      }, [settingsMode, view, scopeKey, expanded, filter, search, autoRefresh, listW, foldersHidden, focusRead, readFont, hideDone])

      // 自动刷新（可选）：仅阅读页挂载时启用；每分钟检查一次、距上次 ≥10 分钟才真正发请求。
      // 静默执行——成功只静默刷新数据（保留已加载页数），失败只留控制台痕迹，
      // 绝不弹错误横幅打断阅读；手动「⟳ 刷新」仍走如实上报路径。
      var AUTO_REFRESH_MS = 10 * 60 * 1000
      var lastAutoRef = useRefFn(0)
      var autoBusyRef = useRefFn(false)
      function autoRefreshTick() {
        var now = Date.now()
        if (!feedsReadyRef.current) return // 订阅列表未就绪：跳过（不烧掉 10 分钟窗口，下个 tick 重试）
        if (now - lastAutoRef.current < AUTO_REFRESH_MS || autoBusyRef.current) return
        lastAutoRef.current = now
        autoBusyRef.current = true
        // 静默刷新；有 FreshRSS 订阅时继续静默同步（greader 订阅不走 standalone refresh）
        var job = call('refresh', {})
        if (frSyncEligible()) {
          job = job.then(function (r) { return (r && r.ok !== false) ? call('freshrss/sync') : r })
        }
        job.then(function (r) {
          autoBusyRef.current = false
          if (r && r.ok) {
            loadFeeds()
            loadArticles({ reset: true, keepPages: true })
          } else if (typeof console !== 'undefined' && console.warn) {
            console.warn('[dsh-rss] 自动刷新未成功（静默，不影响手动操作）', r && r.error)
          }
        }).catch(function (e) {
          autoBusyRef.current = false
          if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-rss] 自动刷新失败（静默）', e && e.message)
        })
      }
      React.useEffect(function () {
        if (!autoRefresh || view !== 'read') return undefined
        autoRefreshTick() // 开启（或切回阅读页）时立即检查一次（10 分钟内不重复）
        if (typeof setInterval !== 'function') return undefined
        var t = setInterval(autoRefreshTick, 60000)
        return function () { clearInterval(t) }
      }, [autoRefresh, view])

      function withBusy(name, p) {
        st.set_busy(name)
        st.set_err(''); st.set_msg('')
        return Promise.resolve(p).then(function (r) {
          st.set_busy('')
          return r
        }).catch(function (e) {
          st.set_busy('')
          throw e
        })
      }

      function openArticle(id) {
        var mySeq = ++seq.current.article
        withBusy('art', call('article', { id: id })).then(function (r) {
          if (seq.current.article !== mySeq) return // 期间已切换文章/作用域：丢弃过期响应
          if (r && r.ok) {
            var a = r.article
            st.set_aiText('')
            st.set_fullHtml(null)
            st.set_article(a)
            if (!a.read) {
              // 打开未读文章 → 标记已读。计数与「已读」视图都只在写成功后更新；
              // 刷新列表用最新作用域参数并保留已加载页数（loadArticles 内部读 cur 快照）。
              call('mark', { id: id, read: true }).then(function (m) {
                if (m && m.ok) {
                  adjustUnread(a.feedId, -1)
                  if (cur.current.article && cur.current.article.id === a.id) st.set_article(Object.assign({}, a, { read: true }))
                  loadArticles({ reset: true, keepPages: true })
                } else {
                  failm(m && m.error ? `标记已读失败：${m.error}` : '标记已读失败')
                }
              }).catch(function (e) { failm(e && e.message) })
            }
          } else failm(r && r.error)
        }).catch(function (e) { failm(e && e.message) })
      }

      function toggleStar(a) {
        // 就地更新当前文章视图，不重新拉取（避免 openArticle 的自动已读副作用）；
        // 完成回调以 cur.current 校验选中是否仍是本文，防止旧闭包把过期状态写回新选中。
        call('mark', { id: a.id, starred: !a.starred }).then(function (r) {
          if (r && r.ok) {
            loadArticles({ reset: true, keepPages: true })
            var now = cur.current.article
            if (now && now.id === a.id) st.set_article(Object.assign({}, now, { starred: !now.starred }))
          } else failm(r && r.error)
        }).catch(function (e) { failm(e && e.message) })
      }

      function toggleRead(a) {
        call('mark', { id: a.id, read: !a.read }).then(function (r) {
          if (r && r.ok) {
            adjustUnread(a.feedId, a.read ? 1 : -1) // 写成功后才动计数
            loadArticles({ reset: true, keepPages: true })
            var now = cur.current.article
            if (now && now.id === a.id) st.set_article(Object.assign({}, now, { read: !now.read }))
          } else failm(r && r.error)
        }).catch(function (e) { failm(e && e.message) })
      }

      /** 存在可用 FreshRSS 账号时，刷新语义要覆盖 greader 订阅（它们不走 standalone refresh）。 */
      function frSyncEligible() {
        var fs0 = cur.current.feeds || []
        var c0 = cur.current.cfg
        return fs0.some(function (f) { return f.kind === 'greader' })
          && Boolean(c0 && c0.freshrss && c0.freshrss.configured && c0.freshrss.enabled && !c0.freshrss.needsReset)
      }

      /** FreshRSS 同步结果汇报（手动「立即同步」与「⟳ 刷新」编排共用）。 */
      function reportSync(r) {
        if (!r) return failm('FreshRSS 同步失败')
        st.set_lastSync(r)
        reloadAfterFeeds(); loadConfig()
        var pushed = Object.keys(r.pushed || {}).map(function (k) { return `${k}×${r.pushed[k]}` }).join('，') || '无'
        var fails = r.pushFailures || []
        var failText = fails.length ? `\n⚠️ ${fails.length} 类推送失败（已保留待同步，下次重试）：${fails.map(function (f) { return `${f.kind}×${f.count}（${f.error}）` }).join('；')}` : ''
        var extra = `${r.removedFeeds ? `；服务端已移除 ${r.removedFeeds} 个订阅` : ''}${r.skippedFeeds ? `；${r.skippedFeeds} 个新订阅因上限跳过` : ''}${r.incremental ? '；增量' : ''}${r.insecure ? '（警告：明文 HTTP 连接）' : ''}`
        if (r.ok === false) failm(`FreshRSS 同步未完全成功：${r.error ? `${r.error}；` : ''}订阅 ${r.feeds}，文章 ${r.items}，已推送：${pushed}${extra}${failText}`)
        else notify(`FreshRSS 同步完成：${r.feeds} 个订阅，${r.items} 篇文章；已推送：${pushed}${extra}${failText}`)
      }

      function doRefresh() {
        var syncAfter = frSyncEligible()
        withBusy('refresh', call('refresh', {})).then(function (r) {
          if (!r) return failm('刷新失败')
          var results = r.results || []
          var fails = results.filter(function (x) { return !x.ok })
          var okCount = results.length - fails.length
          // 全部失败时 r.ok=false 且可能没有顶层 error：也逐条渲染失败原因，不让错误消失
          if (r.error) failm(r.error)
          else if (results.length) {
            var detail = fails.length
              ? `；失败 ${fails.length}/${results.length}：\n${fails.map(function (f) { return `${f.title}：${f.error}` }).join('\n')}`
              : ''
            if (r.ok || okCount > 0) notify(`刷新完成：成功 ${okCount}/${results.length}${detail}`)
            else if (detail) failm(`刷新失败${detail}`)
          }
          // 没有独立订阅且接下来会同步 FreshRSS：不报「没有可刷新的独立订阅」误导——
          // 全是 FreshRSS 订阅的用户，「⟳ 刷新」就该等于把内容更新到最新
          if (!results.length && !r.error && !syncAfter) {
            return failm('没有可刷新的独立订阅（FreshRSS 订阅请在「☁️ FreshRSS」页同步）')
          }
          reloadAfterFeeds()
          if (syncAfter) {
            return withBusy('frsync', call('freshrss/sync')).then(reportSync).catch(function (e) { failm(e && e.message) })
          }
        }).catch(function (e) { failm(e && e.message) })
      }

      /** 添加订阅（订阅管理表单与订阅栏快速添加共用）。 */
      function addFeedByUrl(url, title, group) {
        return withBusy('add', call('feeds/add', { url: url, title: title || undefined, group: group || undefined })).then(function (r) {
          if (r && r.ok) {
            notify(`已添加「${r.feed.title}」，缓存 ${r.counts.added} 篇${r.insecure ? '（注意：该订阅使用明文 HTTP）' : ''}`)
            reloadAfterFeeds()
            return r
          }
          failm(r && r.error)
          return null
        }).catch(function (e) { failm(e && e.message); return null })
      }

      function doAddFeed() {
        if (!addUrl.trim()) return failm('请填写订阅地址')
        addFeedByUrl(addUrl.trim(), addTitle.trim(), addGroup.trim()).then(function (r) {
          if (r) { st.set_addUrl(''); st.set_addTitle(''); st.set_addGroup('') }
        })
      }

      /** 订阅栏快速添加：独立 RSS 订阅在阅读视图内即可添加（无需切到管理页）。 */
      function doQuickAdd() {
        var u = quickUrl.trim()
        if (!u) return failm('请先粘贴 RSS/Atom 地址')
        addFeedByUrl(u).then(function (r) { if (r) st.set_quickUrl('') })
      }

      function doRemoveFeed(f) {
        if (!window.confirm(`确定取消订阅「${f.title}」？已读/收藏记录会一并移除。`)) return
        call('feeds/remove', { id: f.id }).then(function (r) {
          if (r && r.ok) {
            notify('已取消订阅')
            if (scope.kind === 'feed' && scope.id === f.id) st.set_scope({ kind: 'all' })
            if (article && article.feedId === f.id) st.set_article(null)
            reloadAfterFeeds()
          } else failm(r && r.error)
        })
      }

      function doRename(f) {
        var t = window.prompt('新的订阅名称', f.title)
        if (t == null) return
        var g = window.prompt('分组（留空为未分组，多个层级用 / 分隔）', f.group || '')
        if (g == null) return
        call('feeds/update', { id: f.id, title: t, group: g }).then(function (r) {
          if (r && r.ok) { notify('已更新'); reloadAfterFeeds() }
          else failm(r && r.error)
        })
      }

      /** 全部已读：严格按当前作用域（全部/分组子树/未分组/单订阅）下发，绝不越界。 */
      function doMarkAllRead() {
        var body = scopeParams()
        if (!window.confirm(`确定将${scopeLabel()}内的全部文章标为已读？`)) return
        withBusy('markall', call('feeds/mark-all-read', body)).then(function (r) {
          if (r && r.ok) {
            notify(`已将${scopeLabel()}标记 ${r.marked} 篇为已读${r.pending && r.pending.total ? `（${r.pending.total} 条状态待同步 FreshRSS）` : ''}`)
            reloadAfterFeeds()
          } else failm(r && r.error)
        }).catch(function (e) { failm(e && e.message) })
      }

      function doOpmlExport() {
        call('opml/export').then(function (r) {
          if (r && r.ok) {
            var blob = new Blob([r.opml], { type: 'text/x-opml' })
            var a = document.createElement('a')
            a.href = URL.createObjectURL(blob)
            a.download = `dsh-rss-subscriptions-${Date.now()}.opml`
            a.click()
            setTimeout(function () { URL.revokeObjectURL(a.href) }, 5000)
          } else failm(r && r.error)
        })
      }

      function onOpmlFile(ev) {
        var file = ev.target.files && ev.target.files[0]
        if (!file) return
        var reader = new FileReader()
        reader.onload = function () {
          var xml = String(reader.result || '')
          // 先预览（服务端不写入），确认后才导入
          call('opml/import', { xml: xml }).then(function (r) {
            if (r && r.ok && r.preview) {
              st.set_pendingImport({ xml: xml, summary: r })
              notify(`OPML 预览：共 ${r.total} 条，将导入 ${r.toImport} 条（文件内重复 ${r.duplicatesInFile}，已存在 ${r.alreadyExisting}${r.skipped ? `，非法跳过 ${r.skipped}` : ''}${r.groups && r.groups.length ? `；分组：${r.groups.join('、')}` : ''}）。请确认后导入。`)
            } else failm(r && r.error)
          })
        }
        reader.readAsText(file)
        ev.target.value = ''
      }

      function confirmOpmlImport() {
        var pending = pendingImport
        if (!pending) return
        withBusy('opml', call('opml/import', { xml: pending.xml, confirm: true })).then(function (r) {
          st.set_pendingImport(null)
          if (r && r.ok) {
            notify(`OPML 导入完成：新增 ${r.imported}/${r.toImport}${r.truncated ? '（已达订阅上限，其余截断）' : ''}。导入后请点击“⟳ 刷新”。`)
            loadFeeds()
          } else failm(r && r.error)
        }).catch(function (e) { failm(e && e.message) })
      }

      function saveFrConfig(extra) {
        var patch = { freshrss: { baseUrl: frBase.trim(), username: frUser.trim() } }
        if (frPass) patch.freshrss.apiPassword = frPass
        if (extra) Object.assign(patch.freshrss, extra)
        return withBusy('frsave', call('config', { config: patch })).then(function (r) {
          if (r && r.ok) {
            st.set_cfg(r.config)
            st.set_frPass('')
            var fr = r.config.freshrss || {}
            notify('FreshRSS 配置已保存' + (fr.insecureHttp ? '（警告：使用明文 HTTP）' : '') + (fr.needsReset ? '。⚠️ 检测到账号变更：请先点击下方“重置 FreshRSS 数据”确认后才能连接/同步。' : ''))
            return r
          }
          failm(r && r.error); return null
        }).catch(function (e) { failm(e && e.message); return null })
      }

      function doFrConnect() {
        saveFrConfig({ enabled: true }).then(function (r) {
          if (!r) return
          withBusy('frconn', call('freshrss/connect')).then(function (r2) {
            if (r2 && r2.ok) notify(`连接成功：发现 ${r2.feeds} 个订阅${r2.groups && r2.groups.length ? `，分组：${r2.groups.join('、')}` : ''}${r2.insecure ? '（警告：明文 HTTP 连接）' : ''}`)
            else failm(r2 && r2.error)
          }).catch(function (e) { failm(e && e.message) })
        })
      }

      function doFrSync() {
        withBusy('frsync', call('freshrss/sync')).then(reportSync).catch(function (e) { failm(e && e.message) })
      }

      function doFrReset() {
        if (!window.confirm('检测到 FreshRSS 账号已变更。确认将清除本地全部 FreshRSS 订阅、缓存文章、已读/收藏与待同步状态（保留独立 RSS 订阅），然后才能连接新账号。继续？')) return
        withBusy('frreset', call('freshrss/reset')).then(function (r) {
          if (r && r.ok) {
            notify(`已重置 FreshRSS 数据（移除 ${r.feeds} 个订阅、${r.articles} 篇缓存）。现在可以保存新账号并连接。`)
            loadConfig(); reloadAfterFeeds()
          } else failm(r && r.error)
        }).catch(function (e) { failm(e && e.message) })
      }

      function saveAiConfig(extra) {
        var patch = { ai: { baseUrl: aiBase.trim(), model: aiModel.trim(), enabled: aiEnabled } }
        if (aiKey) patch.ai.apiKey = aiKey
        if (extra) Object.assign(patch.ai, extra)
        return withBusy('aisave', call('config', { config: patch })).then(function (r) {
          if (r && r.ok) { st.set_cfg(r.config); st.set_aiKey(''); notify('AI 配置已保存' + (r.config.ai.insecureHttp ? '（警告：使用明文 HTTP）' : '')); return r }
          failm(r && r.error); return null
        }).catch(function (e) { failm(e && e.message); return null })
      }

      function doAi(action, q) {
        var forId = article ? article.id : null
        if (!forId) return
        var needSave = !(cfg && cfg.ai && cfg.ai.configured && cfg.ai.enabled)
        var run = function () {
          st.set_aiBusy(action)
          call('ai/action', { articleId: forId, action: action, question: q }).then(function (r) {
            st.set_aiBusy('')
            // 期间已切换文章：结果仍已保存到该文章，但不落到当前阅读视图
            var stillOpen = cur.current.article && cur.current.article.id === forId
            if (r && r.ok) {
              if (stillOpen) st.set_aiText(r.text)
              notify(`AI ${action === 'summary' ? '摘要' : action === 'translate' ? '翻译' : '回答'}完成（${r.model}）${stillOpen ? '' : '（原文已切换，结果已保存）'}`)
            } else { if (stillOpen) st.set_aiText(''); failm(r && r.error) }
          }).catch(function (e) { st.set_aiBusy(''); failm(e && e.message) })
        }
        if (needSave) { saveAiConfig().then(function (r) { if (r) run() }) }
        else run()
      }

      // 图片显示开关（host 配置 ui.imageMode，跨面板/重启保持）：
      // proxy = 经本地 /dsh-rss/media 代理加载（图床看不到本机 IP，魔数校验+磁盘缓存）；
      // never = 一律占位文本，零远程图片请求。
      var imagesOn = Boolean(cfg && cfg.ui && cfg.ui.imageMode === 'proxy')

      /** 复制文章链接（clipboard API 优先，execCommand 兜底；无 DOM 环境静默失败）。 */
      function copyArticleLink() {
        var u = article && safeHref(article.url)
        if (!u) return failm('该文章没有可复制的链接')
        var legacy = function () {
          try {
            if (typeof document === 'undefined' || !document.body || !document.createElement) return false
            var ta = document.createElement('textarea')
            ta.value = u
            ta.style.position = 'fixed'
            ta.style.opacity = '0'
            document.body.appendChild(ta)
            ta.select()
            var ok = document.execCommand && document.execCommand('copy')
            document.body.removeChild(ta)
            return Boolean(ok)
          } catch (e) { return false }
        }
        var done = function (ok) { ok ? notify('链接已复制') : failm('复制失败，请从「打开原文」手动复制') }
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(u).then(function () { done(true) }, function () { done(legacy()) })
            return
          }
        } catch (e) { /* 走兜底 */ }
        done(legacy())
      }

      /** 抓取全文：原文页提取正文，临时替换当前正文展示（不落盘、不进 AI，切文章即清）。 */
      function fetchFull() {
        if (!article) return
        st.set_fullBusy(true)
        call('article/fetch-full', { id: article.id }).then(function (r) {
          st.set_fullBusy(false)
          var stillOpen = cur.current.article && cur.current.article.id === article.id
          if (r && r.ok) {
            if (stillOpen) st.set_fullHtml(r.html)
            notify(`已抓取全文（约 ${r.chars} 字符${r.insecure ? '；注意：原文为明文 HTTP' : ''}）`)
          } else if (stillOpen) failm(r && r.error)
        }).catch(function (e) { st.set_fullBusy(false); failm(e && e.message) })
      }

      function toggleImages() {
        var next = imagesOn ? 'never' : 'proxy'
        withBusy('img', call('config', { config: { ui: { imageMode: next } } })).then(function (r) {
          if (r && r.ok) {
            st.set_cfg(r.config)
            notify(next === 'proxy'
              ? '已开启图片显示：远程图片经本地代理加载（图床看不到你的 IP）'
              : '已关闭图片显示：文章内图片回到占位文本')
          } else failm(r && r.error)
        }).catch(function (e) { failm(e && e.message) })
      }

      // ---------- 渲染 ----------

      var viewBtn = function (id, label) {
        return h('button', {
          key: id, className: `drss-tab${view === id ? ' on' : ''}`, role: 'tab', 'aria-selected': view === id ? 'true' : 'false',
          onClick: function () { st.set_view(id); st.set_err(''); st.set_msg('') },
        }, label)
      }

      var frWarn = (cfg && cfg.freshrss && cfg.freshrss.insecureHttp)
        ? h('div', { className: 'drss-warn' }, '⚠️ FreshRSS 使用明文 HTTP：API 密码会以明文在网络上传输，建议改用 HTTPS 或仅在内网使用。') : null
      var frResetWarn = (cfg && cfg.freshrss && cfg.freshrss.needsReset)
        ? h('div', { className: 'drss-warn' }, '⚠️ 检测到 FreshRSS 账号已变更：为避免把旧账号的待同步状态写到新账号，连接/同步已停用。请先确认下方“重置 FreshRSS 数据”（保留独立 RSS 订阅）。') : null
      var aiWarn = cfg && cfg.ai && cfg.ai.insecureHttp
        ? h('div', { className: 'drss-warn' }, '⚠️ AI 接口使用明文 HTTP：API Key 会以明文在网络上传输。') : null

      // ---------- 阅读工作台：分组导航栏 / 文章列表 / 阅读栏 ----------

      var items = list.items || []
      var tree = buildGroupTree(feeds)
      var ungroupedFeeds = feeds.filter(function (f) { return !normGroupPath(f.group) })

      var countsOf = function (fid) { return counts && counts[fid] ? counts[fid] : null }
      var sumUnread = function (fl) {
        var n = 0
        for (var i = 0; i < fl.length; i++) { var c = countsOf(fl[i].id); if (c) n += c.unread || 0 }
        return n
      }
      // 子树成员按规范化路径判断（与导航树一致），查询时再展开为原始分组串
      var feedsUnder = function (path) {
        var target = normGroupPath(path)
        var prefix = `${target}/`
        return feeds.filter(function (f) { var ng = normGroupPath(f.group); return ng === target || ng.lastIndexOf(prefix, 0) === 0 })
      }
      // 分组的有效展开态（未记录时用缺省：叶子展开、有子分组的折叠）；切换针对“当前有效值”
      var isOpenOf = function (path, defaultOpen) {
        return expanded[path] === undefined ? defaultOpen : Boolean(expanded[path])
      }
      var toggleExpand = function (path, defaultOpen) {
        st.set_expanded(Object.assign({}, expanded, { [path]: !isOpenOf(path, defaultOpen) }))
      }
      var selectScope = function (next) {
        // 立即作废在途的文章/列表请求：旧响应不得把过期选中/列表写回
        seq.current.article++
        seq.current.list++
        st.set_scope(next)
        st.set_article(null)
        st.set_aiText('')
        st.set_foldersOpen(false)
        st.set_err(''); st.set_msg('')
      }

      /** 计数徽标：未读>0 显示「未读/总数」（强调色），全已读显示灰色总数。 */
      var countPill = function (unread, total) {
        if (!unread && !total) return null
        if (unread) {
          return h('span', { className: 'drss-nav-count', 'aria-label': `${unread} 篇未读，共 ${total} 篇` },
            unread > 99 ? '99+' : `${unread}/${total}`)
        }
        return h('span', { className: 'drss-nav-count dim', 'aria-label': `共 ${total} 篇，无未读` }, String(total))
      }

      /** 「隐藏已读完」过滤：只作用于导航栏显示（作用域/查询不受影响）；
       *  当前选中的订阅/分组即使已读完也保留显示，不丢失浏览上下文。 */
      var feedVisible = function (f) {
        if (!hideDone) return true
        if (scope.kind === 'feed' && scope.id === f.id) return true
        var c = countsOf(f.id)
        return !c || (c.unread || 0) > 0
      }
      var groupVisible = function (node) {
        if (!hideDone) return true
        if (scope.kind === 'group' && scope.path === node.path) return true
        return feedsUnder(node.path).some(feedVisible)
      }

      /** 分组行：选择按钮与折叠按钮是**同级真实按钮**（可聚焦、aria-expanded；Space 默认行为已阻止）。 */
      var groupNavRow = function (key, node, active, unread, total, depth, isOpen) {
        return h('div', { key: key, className: 'drss-nav-item' },
          h('button', {
            key: key + '-chev', className: 'drss-nav-chev', type: 'button',
            'aria-label': (isOpen ? '收起分组 ' : '展开分组 ') + node.label,
            'aria-expanded': isOpen ? 'true' : 'false',
            onClick: function () { toggleExpand(node.path, node.children.length === 0) },
            onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(node.path, node.children.length === 0) } },
          }, isOpen ? '▾' : '▸'),
          h('button', {
            key: key + '-sel', className: `drss-nav-row${active ? ' on' : ''}`, style: { paddingLeft: (8 + depth * 12) + 'px' },
            onClick: function () { selectScope({ kind: 'group', path: node.path }) },
            title: node.label, 'aria-current': active ? 'true' : undefined,
          },
            h('span', { className: 'drss-nav-label' }, node.label),
            countPill(unread, total)))
      }
      var navRow = function (key, label, active, unread, total, onClick, depth) {
        return h('button', {
          key: key, className: `drss-nav-row${active ? ' on' : ''}`, style: { paddingLeft: (8 + depth * 12) + 'px' },
          onClick: onClick, title: label, 'aria-current': active ? 'true' : undefined,
        },
          h('span', { className: 'drss-nav-label' }, label),
          countPill(unread, total))
      }
      var feedNavRow = function (f, depth) {
        var c = countsOf(f.id)
        return navRow(`f:${f.id}`, f.title, scope.kind === 'feed' && scope.id === f.id, c ? c.unread : 0, c ? c.total : 0, function () {
          selectScope({ kind: 'feed', id: f.id })
        }, depth)
      }
      var sumTotal = function (fl) {
        var n = 0
        for (var i = 0; i < fl.length; i++) { var c = countsOf(fl[i].id); if (c) n += c.total || 0 }
        return n
      }
      var renderGroupNodes = function (nodes, depth) {
        var out = []
        nodes.forEach(function (node) {
          if (!groupVisible(node)) return
          // 缺省：无子分组的叶子分组展开、有子分组的折叠；点击折叠按钮按当前有效值切换
          var isOpen = isOpenOf(node.path, node.children.length === 0)
          var gfeeds = feedsUnder(node.path)
          out.push(groupNavRow(`g:${node.path}`, node, scope.kind === 'group' && scope.path === node.path, sumUnread(gfeeds), sumTotal(gfeeds), depth, isOpen))
          if (isOpen) {
            out.push(renderGroupNodes(node.children, depth + 1))
            node.feeds.filter(feedVisible).forEach(function (f) { out.push(feedNavRow(f, depth + 1)) })
          }
        })
        return out
      }

      var visibleUngrouped = ungroupedFeeds.filter(feedVisible)
      var groupNodes = renderGroupNodes(tree, 0)
      var anyFeedVisible = tree.some(function (node) { return feedsUnder(node.path).some(feedVisible) }) || visibleUngrouped.length > 0

      var foldersPane = h('nav', { className: 'drss-folders', 'aria-label': '订阅分组' },
        h('div', { className: 'drss-nav-head' },
          h('div', { className: 'drss-nav-title', style: { margin: '0' } }, '订阅'),
          h('button', {
            className: `drss-hide-done${hideDone ? ' on' : ''}`, type: 'button',
            'aria-pressed': hideDone ? 'true' : 'false',
            title: hideDone ? '当前隐藏已读完的订阅。点击显示全部' : '当前显示全部订阅。点击隐藏已读完的',
            onClick: function () { st.set_hideDone(!hideDone) },
          }, hideDone ? '只看未读' : '显示全部')),
        // 「全部」未读：优先用每订阅真实计数求和（与分组一致、随读/标即时同步），无 counts 时回落 stats
        navRow('all', '全部文章', scope.kind === 'all', counts ? sumUnread(feeds) : (stats ? stats.unread : 0), counts ? sumTotal(feeds) : (stats ? stats.articles : 0), function () { selectScope({ kind: 'all' }) }, 0),
        groupNodes,
        visibleUngrouped.length ? [
          h('div', { key: 'ung-sep', className: 'drss-nav-sep' }),
          navRow('ung', '未分组', scope.kind === 'ungrouped', sumUnread(visibleUngrouped), sumTotal(visibleUngrouped), function () { selectScope({ kind: 'ungrouped' }) }, 0),
        ] : null,
        visibleUngrouped.map(function (f) { return feedNavRow(f, 1) }),
        !anyFeedVisible && feeds.length ? h('div', { key: 'allread', className: 'drss-empty' }, '🎉 全部已读。点击右上角「只看未读」可显示全部订阅。') : null,
        h('div', { key: 'add', className: 'drss-nav-add' },
          h('input', {
            className: 'drss-in', placeholder: '粘贴 RSS/Atom 地址，快速订阅…', 'aria-label': '快速添加订阅',
            value: quickUrl, onChange: function (e) { st.set_quickUrl(e.target.value) },
            onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); doQuickAdd() } },
          }),
          h('button', { className: 'drss-btn pri', disabled: Boolean(busy), onClick: doQuickAdd, title: '添加订阅（独立 RSS，无需 FreshRSS）' }, busy === 'add' ? '…' : '＋')),
        h('div', { key: 'foot', className: 'drss-side-foot' },
          stats ? `共 ${stats.articles} 篇 · 未读 ${stats.unread} · 收藏 ${stats.starred}${stats.pendingFresh && stats.pendingFresh.total ? ` · 待同步 ${stats.pendingFresh.total}` : ''}` : ''))

      var filterBtn = function (id, label) {
        return h('button', { key: id, className: `drss-pill${filter === id ? ' on' : ''}`, 'aria-pressed': filter === id ? 'true' : 'false', onClick: function () { st.set_filter(id) } }, label)
      }

      /** 列表行（qiaomu 式扫描面）：顶部 meta（未读点·来源…★时间）+ 两行标题 + 两行摘要
       *  + 可选 64px 缩略图（图片开关开启时取首图经本地代理）。 */
      var articleRow = function (a) {
        var thumbSrc = imagesOn ? firstImgOf(a.contentHtml || a.summaryHtml) : null
        return h('button', {
          key: a.id, className: `drss-item${a.read ? ' read' : ''}${article && article.id === a.id ? ' sel' : ''}`,
          onClick: function () { openArticle(a.id) },
        },
          h('div', { className: 'drss-item-meta', title: fmtDate(a.publishedMs) },
            a.read ? null : h('span', { className: 'drss-dot', 'aria-hidden': 'true' }),
            h('span', { className: 'drss-item-feed' }, a.feedTitle),
            a.starred ? h('span', { className: 'drss-star', 'aria-label': '已收藏' }, '★') : null,
            h('span', { className: 'drss-item-date' }, relTime(a.publishedMs))),
          h('div', { className: 'drss-item-title' }, a.title),
          a.excerpt ? h('div', { className: 'drss-item-sum' }, a.excerpt) : null,
          thumbSrc ? h('span', { className: 'drss-item-thumb', 'aria-hidden': 'true' },
            h('img', { src: '/dsh-rss/media?u=' + encodeURIComponent(thumbSrc), alt: '', loading: 'lazy' })) : null)
      }

      var listPane = h('div', { className: 'drss-list' },
        h('div', { className: 'drss-list-bar' },
          filterBtn('all', '全部'), filterBtn('unread', '未读'), filterBtn('starred', '收藏'),
          h('input', { ref: searchRef, className: 'drss-in wide', placeholder: '搜索标题与正文…', 'aria-label': '搜索文章', value: search, onChange: function (e) { st.set_search(e.target.value) } }),
          h('label', { className: 'drss-label', title: '每 10 分钟自动刷新订阅（仅阅读页打开时；静默执行，失败不影响手动操作）' },
            h('input', { type: 'checkbox', checked: autoRefresh, onChange: function (e) { st.set_autoRefresh(e.target.checked) } }),
            ' 自动'),
          h('button', { className: 'drss-btn', disabled: Boolean(busy), onClick: doRefresh, 'aria-label': '刷新当前订阅' }, busy === 'refresh' ? '刷新中…' : '⟳ 刷新'),
          h('button', { className: 'drss-btn', onClick: doMarkAllRead, title: `将${scopeLabel()}标为已读` }, '全部已读'),
          h('button', { className: 'drss-btn', onClick: doOpmlExport, 'aria-label': '导出 OPML 订阅' }, '导出 OPML'),
          h('label', { className: 'drss-btn', title: '导入 OPML 订阅文件' }, '导入 OPML', h('input', { type: 'file', accept: '.opml,.xml,text/xml,text/x-opml', style: { display: 'none' }, onChange: onOpmlFile }))),
        pendingImport ? h('div', { className: 'drss-sec', style: { margin: '8px 10px' } },
          h('div', { className: 'drss-row' },
            h('span', { className: 'drss-label' }, `OPML 待确认：将导入 ${pendingImport.summary.toImport} / ${pendingImport.summary.total} 条`),
            h('button', { className: 'drss-btn pri', disabled: Boolean(busy), onClick: confirmOpmlImport }, busy === 'opml' ? '导入中…' : '✓ 确认导入'),
            h('button', { className: 'drss-btn', onClick: function () { st.set_pendingImport(null); notify('已取消导入') } }, '取消'))) : null,
        list.loading && !items.length ? h('div', { className: 'drss-loading' }, '加载中…')
          : items.length ? items.map(articleRow)
            : h('div', { className: 'drss-empty' }, feeds.length ? '当前范围内暂无文章。' : '暂无文章。先在「订阅管理」添加订阅，或到「FreshRSS」连接账号同步。'),
        items.length && items.length < list.total
          ? h('button', { className: 'drss-btn drss-more', disabled: Boolean(busy) || list.loading, onClick: function () { loadArticles({}) } }, list.loading ? `加载中…（已显示 ${items.length} / ${list.total}）` : `加载更多（已显示 ${items.length} / ${list.total}）`)
          : (items.length ? h('div', { className: 'drss-more-note' }, list.loading ? '刷新中…' : `已显示全部 ${list.total} 篇`) : null))

      var readPane = article ? (function () {
        var aiBlock = aiText
          ? h('div', { className: 'drss-ai' },
              h('div', { className: 'drss-ai-h' }, '✨ 本次结果'), h('div', { className: 'drss-ai-b' }, aiText))
          : null
        var savedAi = (article.aiResults || []).map(function (r, i) {
          return h('div', { className: 'drss-ai', key: 'sai' + i },
            h('div', { className: 'drss-ai-h' }, `✨ 已保存的${r.action === 'summary' ? '摘要' : r.action === 'translate' ? '翻译' : '回答'}（${r.model}，${fmtDate(r.createdAt)}）`),
            h('div', { className: 'drss-ai-b' }, r.text))
        })
        // article.url 是不可信外部数据：只有通过 http/https 校验才渲染链接
        var srcLink = article.url && safeHref(article.url)
          ? h('a', { className: 'drss-btn pri', href: srcLink, target: '_blank', rel: 'noreferrer noopener' }, '打开原文') : null
        // 媒体块（点击加载前零网络请求）：播客 enclosure 音频；文章链接是 YouTube/B 站视频页时嵌入官方播放器
        var audioSrc = audioEnclosureOf(article)
        var embedSrc = audioSrc ? null : videoEmbedOf(article.url)
        var mediaBlock = audioSrc
          ? (audioOpen === article.id
              ? h('audio', { className: 'drss-audio', controls: true, preload: 'metadata', src: audioSrc }, null)
              : h('div', { className: 'drss-media-hint' },
                  h('button', { className: 'drss-btn pri', onClick: function () { st.set_audioOpen(article.id) } }, '▶ 加载播客音频'),
                  h('span', { className: 'drss-label' }, '点击后才连接音频源（不经过代理）')))
          : (embedSrc
              ? (videoOpen === article.id
                  ? h('iframe', {
                      className: 'drss-video', src: embedSrc, title: '视频播放器', allowFullScreen: '',
                      allow: 'autoplay; encrypted-media; picture-in-picture',
                      sandbox: 'allow-scripts allow-same-origin allow-presentation allow-popups',
                      referrerPolicy: 'strict-origin-when-cross-origin',
                    }, null)
                  : h('div', { className: 'drss-media-hint' },
                      h('button', { className: 'drss-btn pri', onClick: function () { st.set_videoOpen(article.id) } }, '▶ 在阅读器内播放视频'),
                      h('span', { className: 'drss-label' }, '加载 YouTube/B 站官方播放器')))
              : null)
        return h('div', { className: 'drss-read' },
          h('div', { className: 'drss-read-bar' },
            h('button', { className: 'drss-btn', onClick: function () { st.set_article(null) }, 'aria-label': '返回文章列表' }, '← 返回'),
            h('button', { className: 'drss-btn', onClick: function () { toggleRead(article) }, title: '快捷键 R' }, article.read ? '标为未读' : '标为已读'),
            h('button', { className: 'drss-btn', onClick: function () { toggleStar(article) }, title: '快捷键 S' }, article.starred ? '★ 取消收藏' : '☆ 收藏'),
            srcLink,
            h('button', { className: 'drss-btn', onClick: copyArticleLink, title: '复制文章链接' }, '🔗 复制链接'),
            h('span', { className: 'drss-font-ctl', role: 'group', 'aria-label': '正文字号' },
              h('button', { className: 'drss-btn', onClick: function () { st.set_readFont(clampNum(readFont - 1, 14, 22, 17)) }, 'aria-label': '减小字号' }, 'A−'),
              h('span', { className: 'drss-label', 'aria-hidden': 'true' }, String(readFont)),
              h('button', { className: 'drss-btn', onClick: function () { st.set_readFont(clampNum(readFont + 1, 14, 22, 17)) }, 'aria-label': '增大字号' }, 'A+')),
            fullHtml
              ? h('button', { className: 'drss-btn on', onClick: function () { st.set_fullHtml(null); notify('已切回订阅源缓存正文') }, title: '当前展示的是抓取的全文，点击切回订阅源缓存' }, '↩ 缓存正文')
              : h('button', { className: 'drss-btn', disabled: fullBusy, onClick: fetchFull, title: '抓取原文页面正文（适合只有摘要的订阅；不落盘，切换文章即恢复）' }, fullBusy ? '抓取中…' : '⤓ 抓取全文'),
            h('button', {
              className: `drss-btn${focusRead ? ' on' : ''}`, 'aria-pressed': focusRead ? 'true' : 'false',
              title: focusRead ? '退出专注模式（显示文章列表），快捷键 F' : '专注模式：收起文章列表，全宽阅读，快捷键 F',
              onClick: function () { st.set_focusRead(!focusRead) },
            }, focusRead ? '⇤ 退出专注' : '⇥ 专注'),
            h('button', {
              className: `drss-btn${imagesOn ? ' on' : ''}`, 'aria-pressed': imagesOn ? 'true' : 'false',
              title: imagesOn
                ? '图片经本地代理加载（图床看不到你的 IP）。点击关闭'
                : '经本地代理加载文章内远程图片（图床看不到你的 IP，缓存 100 张/64MB）。点击开启',
              onClick: toggleImages,
            }, imagesOn ? '🖼 图片：开' : '🖼 图片：关')),
          h('div', { className: 'drss-read-inner' },
            // 旧版缓存识别：图片开关已开但正文仍是文本标记（旧版入库时图片被替换），
            // 明确告诉用户怎么恢复，而不是让「开了开关却没图」无声发生
            imagesOn && String(article.contentHtml || article.summaryHtml || '').indexOf('［图片') >= 0
              ? h('div', { className: 'drss-warn' }, '这篇是旧版缓存的图文：入库时图片被存成了文本标记。点顶部「⟳ 刷新」（或 FreshRSS 页「⇅ 立即同步」）重新拉取，即可恢复图片与缩略图。')
              : null,
            mediaBlock,
            h('div', { className: 'drss-art-title' }, article.title),
            h('div', { className: 'drss-art-meta' },
              h('span', null, fmtDate(article.publishedMs)),
              h('span', null, article.feedTitle),
              article.group ? h('span', null, article.group) : null,
              article.author ? h('span', null, article.author) : null,
              article.feedKind === 'greader' ? h('span', { className: 'drss-badge' }, 'FreshRSS') : null,
              article.read ? h('span', { className: 'drss-badge' }, '已读') : h('span', { className: 'drss-badge' }, '未读')),
            h('div', { className: 'drss-sec' },
              h('div', { className: 'drss-row' },
                h('button', { className: 'drss-btn pri', disabled: Boolean(aiBusy), onClick: function () { doAi('summary') } }, aiBusy === 'summary' ? '生成中…' : '✨ AI 摘要'),
                h('button', { className: 'drss-btn pri', disabled: Boolean(aiBusy), onClick: function () { doAi('translate') } }, aiBusy === 'translate' ? '生成中…' : '🌐 AI 翻译'),
                cfg && cfg.ai && cfg.ai.configured ? null : h('span', { className: 'drss-label' }, '（先在「AI 设置」里配置接口与 Key）')),
              h('div', { className: 'drss-row' },
                h('input', { className: 'drss-in wide', placeholder: '就这篇文章提问…', 'aria-label': '针对本文提问', value: question, onChange: function (e) { st.set_question(e.target.value) } }),
                h('button', { className: 'drss-btn pri', disabled: Boolean(aiBusy) || !question.trim(), onClick: function () { doAi('ask', question.trim()) } }, aiBusy === 'ask' ? '回答中…' : '💬 提问'))),
            aiBlock, savedAi,
            fullHtml ? h('div', { className: 'drss-full-note' }, '⤓ 以下为抓取的原文正文（未入库；切回按钮在上面的工具栏）') : null,
            h('div', { className: 'drss-body', style: { fontSize: readFont + 'px' } }, renderSafe(fullHtml || article.contentHtml || article.summaryHtml, 'art', { images: imagesOn }))))
      })() : h('div', { className: 'drss-read' },
        h('div', { className: 'drss-read-inner' },
          h('div', { className: 'drss-empty' }, '从列表选择一篇文章开始阅读。')))

      // 列表/阅读栏拖宽手柄（qiaomu 式）：pointer 捕获拖动，宽度钳制并持久化
      var dragRef = useRefFn(null) // {x, w} 拖拽起点
      var splitHandle = h('div', {
        className: 'drss-split', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': '调整列表栏宽度',
        tabIndex: 0,
        onPointerDown: function (e) {
          dragRef.current = { x: e.clientX, w: listW }
          if (e.currentTarget && typeof e.currentTarget.setPointerCapture === 'function') {
            try { e.currentTarget.setPointerCapture(e.pointerId) } catch (e2) { /* 测试环境无指针捕获 */ }
          }
        },
        onPointerMove: function (e) {
          if (!dragRef.current) return
          st.set_listW(clampNum(dragRef.current.w + (e.clientX - dragRef.current.x), 240, 560, 320))
        },
        onPointerUp: function (e) {
          dragRef.current = null
          if (e.currentTarget && typeof e.currentTarget.releasePointerCapture === 'function') {
            try { e.currentTarget.releasePointerCapture(e.pointerId) } catch (e2) { /* 忽略 */ }
          }
        },
        onKeyDown: function (e) {
          var step = e.key === 'ArrowLeft' ? -24 : e.key === 'ArrowRight' ? 24 : 0
          if (!step) return
          e.preventDefault()
          st.set_listW(clampNum(listW + step, 240, 560, 320))
        },
      })

      // 三栏独立展开/收起：订阅栏（顶栏 ☰，持久化）、列表栏（专注模式，F 键/按钮）；
      // 收起即不渲染（网格列随实际渲染的栏位动态生成），窄容器仍走单栏 + 抽屉布局。
      var showFoldersPane = !foldersHidden
      var showListPane = !(focusRead && article)
      var gridCols = []
      if (showFoldersPane) gridCols.push('212px')
      if (showListPane) gridCols.push(`${listW}px`, '5px')
      gridCols.push('minmax(0,1fr)')
      var readView = h('div', {
        className: 'drss-main',
        style: { gridTemplateColumns: gridCols.join(' ') },
      }, showFoldersPane ? foldersPane : null, showListPane ? listPane : null, showListPane ? splitHandle : null, readPane)

      // 键盘：/ 聚焦搜索、J/K（或方向键）列表内移动、R 已读、S 收藏、Esc 返回/关抽屉
      React.useEffect(function () {
        if (typeof window.addEventListener !== 'function') return undefined
        var onKey = function (e) {
          try {
            var tag = e.target && e.target.tagName ? String(e.target.tagName).toLowerCase() : ''
            var typing = tag === 'input' || tag === 'textarea' || tag === 'select'
            if (e.key === 'Escape') {
              if (article) st.set_article(null)
              else if (foldersOpen) st.set_foldersOpen(false)
              return
            }
            if (typing || view !== 'read' || e.ctrlKey || e.metaKey || e.altKey) return
            if (e.key === '/') {
              if (searchRef.current && searchRef.current.focus) { e.preventDefault(); searchRef.current.focus() }
              return
            }
            if (e.key === 'j' || e.key === 'ArrowDown' || e.key === 'k' || e.key === 'ArrowUp') {
              if (!items.length) return
              e.preventDefault()
              var idx = article ? items.findIndex(function (x) { return x.id === article.id }) : -1
              var next = idx < 0 ? items[0] : (items[idx + ((e.key === 'j' || e.key === 'ArrowDown') ? 1 : -1)] || items[idx])
              if (next && (!article || next.id !== article.id)) openArticle(next.id)
              return
            }
            if (!article) return
            if (e.key === 'r') toggleRead(article)
            else if (e.key === 's') toggleStar(article)
            else if (e.key === 'f') st.set_focusRead(!focusRead)
          } catch (e2) { /* 键盘处理绝不抛错 */ }
        }
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('keydown', onKey) }
      }, [view, article, items, foldersOpen, focusRead])

      var body = null

      if (view === 'read') {
        body = readView
      } else if (view === 'manage') {
        body = h('div', { className: 'drss-view' }, h('div', { className: 'drss-view-inner' },
          h('div', { className: 'drss-view-head' },
            h('span', { className: 'drss-view-title' }, '订阅管理'),
            h('span', { className: 'drss-view-sub' }, '独立 RSS/Atom 订阅的增删改；分组支持「组/子组」路径')),
          h('div', { className: 'drss-sec' },
            h('div', { className: 'drss-row' },
              h('input', { className: 'drss-in wide', placeholder: 'RSS/Atom 地址（https://…）', value: addUrl, onChange: function (e) { st.set_addUrl(e.target.value) } }),
              h('input', { className: 'drss-in', placeholder: '名称（可选）', value: addTitle, onChange: function (e) { st.set_addTitle(e.target.value) } }),
              h('input', { className: 'drss-in', placeholder: '分组（可选）', value: addGroup, onChange: function (e) { st.set_addGroup(e.target.value) } }),
              h('button', { className: 'drss-btn pri', disabled: Boolean(busy), onClick: doAddFeed }, busy === 'add' ? '添加中…' : '＋ 添加订阅'))),
          feeds.length ? h('div', { className: 'drss-sec' }, feeds.map(function (f) {
            var c = countsOf(f.id)
            return h('div', { key: f.id, className: 'drss-row' },
              h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                `${f.kind === 'greader' ? '[FreshRSS] ' : ''}${f.title}`,
                f.group ? h('span', { className: 'drss-badge' }, f.group) : null,
                c && c.unread ? h('span', { className: 'drss-badge' }, `未读 ${c.unread}`) : null),
              f.lastError ? h('span', { className: 'drss-err' }, `上次错误：${f.lastError}`) : null,
              h('button', { className: 'drss-btn', onClick: function () { doRename(f) } }, '编辑'),
              f.kind === 'standalone' ? h('button', { className: 'drss-btn danger', onClick: function () { doRemoveFeed(f) } }, '退订') : null)
          })) : h('div', { className: 'drss-empty' }, '还没有订阅。'),
          h('div', { className: 'drss-msg' }, '提示：FreshRSS 账号订阅请在「FreshRSS」页同步管理（跟随服务端，不在此退订）。')))
      } else if (view === 'freshrss') {
        var fr = cfg && cfg.freshrss
        body = h('div', { className: 'drss-view' }, h('div', { className: 'drss-view-inner' },
          h('div', { className: 'drss-view-head' },
            h('span', { className: 'drss-view-title' }, '☁️ FreshRSS'),
            h('span', { className: 'drss-view-sub' }, '账号级连接：订阅与文章从服务端同步，已读/收藏双向写回')),
          frWarn,
          frResetWarn,
          h('div', { className: 'drss-sec' },
            h('div', { className: 'drss-row' }, h('span', { className: 'drss-label' }, '把 FreshRSS 账号整个接入：订阅列表与文章从服务端同步，已读/收藏会双向写回。账号（地址+用户名）变更后需先重置本地 FreshRSS 数据。')),
            h('div', { className: 'drss-row' },
              h('input', { className: 'drss-in wide', placeholder: 'FreshRSS 地址，如 https://freshrss.example.net（或完整 /api/greader.php）', value: frBase, onChange: function (e) { st.set_frBase(e.target.value) } })),
            h('div', { className: 'drss-row' },
              h('input', { className: 'drss-in', placeholder: '用户名', value: frUser, onChange: function (e) { st.set_frUser(e.target.value) } }),
              h('input', { className: 'drss-in', type: 'password', placeholder: fr && fr.hasApiPassword ? 'API 密码（已配置，留空保持不变）' : 'API 密码（FreshRSS 设置里生成）', value: frPass, onChange: function (e) { st.set_frPass(e.target.value) } })),
            h('div', { className: 'drss-row' },
              h('button', { className: 'drss-btn pri', disabled: Boolean(busy), onClick: doFrConnect }, busy === 'frconn' ? '连接中…' : '保存并测试连接'),
              h('button', { className: 'drss-btn pri', disabled: Boolean(busy), onClick: doFrSync }, busy === 'frsync' ? '同步中…' : '⇅ 立即同步'),
              fr && fr.configured ? h('span', { className: 'drss-badge' }, '已配置') : null),
            fr && fr.needsReset ? h('div', { className: 'drss-row' },
              h('button', { className: 'drss-btn danger', disabled: Boolean(busy), onClick: doFrReset }, busy === 'frreset' ? '重置中…' : '⚠️ 重置 FreshRSS 数据（确认账号变更）')) : null,
            h('div', { className: 'drss-msg' }, 'FreshRSS 需先在服务端「设置 → 认证」开启 API 访问并生成专用的 API 密码（不是登录密码）。'),
            lastSync ? h('div', { className: 'drss-kv' }, h('b', null, '上次同步'), `订阅 ${lastSync.feeds} · 文章 ${lastSync.items} · 推送 ${JSON.stringify(lastSync.pushed || {})}${(lastSync.pushFailures || []).length ? ` · 待重试 ${lastSync.pushFailures.length} 类` : ''}`) : null)))
      } else {
        var ai = cfg && cfg.ai
        body = h('div', { className: 'drss-view' }, h('div', { className: 'drss-view-inner' },
          h('div', { className: 'drss-view-head' },
            h('span', { className: 'drss-view-title' }, '✨ AI 设置'),
            h('span', { className: 'drss-view-sub' }, '自带 Key（BYOK），不复用 DSH 内置模型账号')),
          aiWarn,
          h('div', { className: 'drss-sec' },
            h('div', { className: 'drss-row' }, h('span', { className: 'drss-label' }, '自带 Key（BYOK）：调用你配置的 OpenAI 兼容接口（如 api.deepseek.com/v1、api.openai.com/v1、本地 Ollama/LiteLLM）。不会复用 DSH 内置模型账号；Key 仅存本机 0600 文件，不会显示给浏览器/工具/日志。')),
            h('div', { className: 'drss-row' },
              h('input', { className: 'drss-in wide', placeholder: '接口地址，如 https://api.deepseek.com/v1', value: aiBase, onChange: function (e) { st.set_aiBase(e.target.value) } })),
            h('div', { className: 'drss-row' },
              h('input', { className: 'drss-in', placeholder: '模型名，如 deepseek-chat', value: aiModel, onChange: function (e) { st.set_aiModel(e.target.value) } }),
              h('input', { className: 'drss-in', type: 'password', placeholder: ai && ai.hasApiKey ? 'API Key（已配置，留空保持不变）' : 'API Key', value: aiKey, onChange: function (e) { st.set_aiKey(e.target.value) } })),
            h('div', { className: 'drss-row' },
              h('label', { className: 'drss-label' }, h('input', { type: 'checkbox', checked: aiEnabled, onChange: function (e) { st.set_aiEnabled(e.target.checked) } }), ' 启用 AI 功能'),
              h('button', { className: 'drss-btn pri', disabled: Boolean(busy), onClick: function () { saveAiConfig() } }, busy === 'aisave' ? '保存中…' : '保存 AI 配置'),
              ai && ai.configured ? h('span', { className: 'drss-badge' }, ai.enabled ? '已启用' : '已配置未启用') : null),
            h('div', { className: 'drss-msg' }, '文章正文仅在你在阅读页点击「AI 摘要 / 翻译 / 提问」时才会发送给该接口；正文被当作不可信数据处理，AI 输出不会自动执行任何操作。'))))
      }

      // 宿主/客户端版本不一致提示：硬刷新只更新客户端半边，宿主半边必须重启 DSH——
      // 这种状态下新路由（图片代理等）在旧宿主上 404，与其无声失败不如显式指引。
      var verMismatch = hostVersion && hostVersion !== CLIENT_VERSION && !verHintClosed
      var verHint = verMismatch ? h('div', { className: 'drss-warn', role: 'alert' },
        `⚠️ 插件宿主仍在运行 v${hostVersion}（界面已是 v${CLIENT_VERSION}）：本地路径安装不会热更新宿主端，图片代理等新功能在旧宿主上不可用。请完全退出并重启 DSH Desktop，再硬刷新浏览器（Cmd/Ctrl+Shift+R）。`,
        h('button', { className: 'drss-btn', style: { marginLeft: '10px', flex: '0 0 auto' }, onClick: function () { st.set_verHintClosed(true) } }, '知道了')) : null

      return h('div', {
        className: 'drss-root',
        'data-folders': foldersOpen ? 'open' : 'closed',
        'data-art': article ? '1' : '0',
      },
        h('div', { className: 'drss-topbar' },
          view === 'read' ? h('button', { className: 'drss-btn drss-folders-btn', 'aria-label': '切换订阅分组栏', onClick: function () { st.set_foldersOpen(!foldersOpen) } }, '☰ 订阅') : null,
          view === 'read' ? h('button', {
            className: `drss-btn drss-folders-toggle${foldersHidden ? '' : ' on'}`, 'aria-pressed': foldersHidden ? 'false' : 'true',
            title: foldersHidden ? '展开订阅分组栏' : '收起订阅分组栏',
            onClick: function () { st.set_foldersHidden(!foldersHidden) },
          }, '☰') : null,
          h('span', { className: 'drss-brand' }, 'RSS 阅读'),
          view === 'read' && scope.kind !== 'all' ? h('span', { className: 'drss-scope', title: '当前浏览作用域' }, scopeLabel()) : null,
          h('span', { style: { flex: '1 1 auto' } }),
          h('div', { className: 'drss-tabs', role: 'tablist' },
            settingsMode ? null : viewBtn('read', '📖 阅读'),
            viewBtn('manage', '🗂 订阅管理'), viewBtn('freshrss', '☁️ FreshRSS'), viewBtn('ai', '✨ AI 设置'))),
        verHint,
        msg ? h('div', { className: 'drss-msg', role: 'status' }, msg) : null,
        err ? h('div', { className: 'drss-msg drss-err', role: 'alert' }, err) : null,
        h('div', { className: 'drss-shell' }, body))
    }

    // ---------- 插件注册 ----------

    // 面板 ID：左栏行与 main 页共用同一身份（布局 MainPanelId 域；与插件同名，不与其他面板冲突）
    var PANEL_ID = 'dsh-rss'

    // 左栏入口图标：宿主行传入 size（active 态由行自身样式表达；图标用 currentColor 跟随主题）
    function ReaderEntryIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: '1.2', strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M2.5 2.5a11 11 0 0 1 11 11' }),
        h('path', { d: 'M2.5 7.5a6 6 0 0 1 6 6' }),
        h('circle', { cx: '3.75', cy: '12.25', r: '1.25', fill: 'currentColor', stroke: 'none' }))
    }

    // 中栏页面：主面板须为桌面窗口铬条留出官方间隙（同 dsh-slidestudio 的 StandaloneSlidesPage）
    function ReaderPage() {
      return h('div', {
        style: {
          height: '100%', boxSizing: 'border-box', overflow: 'auto',
          paddingTop: 'var(--dsh-frame-top-clearance, 0px)',
        },
      }, h(App, {}))
    }

    function apply(ctx) {
      var slots = ctx && ctx.get ? ctx.get('slots') : undefined
      if (slots === undefined) return
      ensureStyles()
      // settings.section：slot 声明可能尚未就绪 → slots.inject 等声明后注册；
      // 返回的 disposer 由 slot 宿主管理（声明下线时随之注销）。
      // settings.section：设置入口渲染**专用设置面板**（仅 管理/FreshRSS/AI 分区），
      // 不塞完整阅读工作台；面板状态不读写浏览上下文持久化（mode='settings'）。
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'dsh-rss', order: 60, label: function () { return 'RSS 阅读' } },
          function (props) { return h(App, Object.assign({}, props, { mode: 'settings' })) },
        )
      })
      // 左侧主导航入口（一等面板，与其他插件并排）——「两次注册、同一身份」：
      //   main              → 布局根键控中栏页：选中本面板时挂载（进入挂载/离开卸载，
      //                       页面的挂载即打开）；
      //   sidebar.panellist → 左栏全局面板行：宿主拥有行的按钮/标签/选中态与点击选中，
      //                       本插件只贡献图标与 label。
      // 座位声明可能晚于本模块加载（或宿主不声明）→ slots.inject 等声明就绪；
      // 未声明时回调不运行（入口缺失而非启动失败）。两个停止函数由 ctx.effect 持有，
      // 模块卸载时统一注销，不丢弃 disposer。
      var navStops = [
        slots.inject('main', function () {
          return slots.register({ name: 'main', key: PANEL_ID }, ReaderPage)
        }),
        slots.inject('sidebar.panellist', function () {
          return slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: function () { return 'RSS 阅读' } },
            ReaderEntryIcon,
          )
        }),
      ]
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            for (var i = 0; i < navStops.length; i++) {
              try { navStops[i]() } catch (e) { /* 座位已由宿主先行回收 */ }
            }
          }
        })
      }
      // 可选 dsh-better-sidebar（≥0.24）右侧栏 tab：嵌套 ctx.inject 声明式响应式注册。
      // 运行时契约（Cordis/DSH；同构用法 dshmarket src/client/index.ts:146-161、
      // dsh-agent-sync index.mjs:1795-1814）：
      // - 不把 betterSidebar 写进模块级 exports.inject：否则未装 better-sidebar 的宿主上
      //   整个客户端模块不激活，设置入口也会消失（constraint：Better Sidebar 保持可选）；
      // - 服务未提供时回调不运行（设置入口不受影响）；上线时回调恰好运行一次；
      // - scope.get 解析服务，scope.effect 持有 registerTab 返回的注销函数：
      //   服务下线/本模块销毁时自动注销，恢复时回调重跑。旧注册已随 disposer 注销、
      //   且服务重建后是全新注册表，不会出现重复 id，也不丢弃 disposer；
      // - 注册失败（如宿主重复 id 抛错）如实上抛给 fiber，不静默吞掉。
      if (typeof ctx.inject !== 'function') {
        // 现行 DSH 客户端运行时均提供 ctx.inject；缺失属环境异常，可见告警而非静默跳过。
        console.warn('[dsh-rss] 宿主缺少 ctx.inject：Better Sidebar 右侧栏 tab 未注册（设置入口不受影响）')
        return
      }
      ctx.inject(['betterSidebar'], function (scope) {
        var bs = scope && typeof scope.get === 'function' ? scope.get('betterSidebar') : undefined
        if (!bs || typeof bs.registerTab !== 'function') {
          console.warn('[dsh-rss] betterSidebar 服务缺少 registerTab：右侧栏 tab 未注册')
          return
        }
        scope.effect(function () {
          return bs.registerTab({
            id: 'dsh-rss:reader',
            title: 'RSS 阅读',
            description: '自定义 RSS/Atom · FreshRSS 账号同步 · AI 摘要与问答',
            single: true, // 打开时聚焦既有 tab，不重复开
            component: function () { return h(App, {}) },
          })
        })
      })
    }

    exports.apply = apply
    // 模块级依赖：仅声明必定存在的 slots（loader 据此等待服务就绪后再 apply）。
    // betterSidebar 刻意不在此列——保持可选，见 apply 内嵌套 inject 说明。
    exports.inject = ['slots']
    exports.renderSafe = renderSafe
    exports.decodeEntitiesLite = decodeEntitiesLite
    exports._call = call
    exports._App = App // 内部导出：行为回归测试用（生产代码不依赖）
    exports._relTime = relTime
    exports._parseRes = parseRes // 内部导出：响应解析鲁棒性的单元测试用
    exports._validSavedScope = validSavedScope // 内部导出：持久化恢复校验的单元测试用
    return module.exports
  },
})
