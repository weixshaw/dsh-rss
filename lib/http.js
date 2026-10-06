import { RssError } from './util.js'

/**
 * 有界 HTTP 抓取：协议白名单（http/https）、超时中断、响应体积上限、
 * 可选禁用重定向（用于携带凭据的请求，拒绝跨源凭据重定向）。
 * opts.binary=true 时返回原始字节（buffer），不做 utf8 文本解码（图片等二进制必须走这条路径）。
 */

export class HttpError extends RssError {
  constructor(message, { status = 0 } = {}) {
    super(message, { status })
    this.name = 'HttpError'
  }
}

const DEFAULTS = {
  method: 'GET',
  headers: {},
  body: null,
  timeoutMs: 15000,
  maxBytes: 2 * 1024 * 1024,
  redirect: 'follow',
  binary: false,
}

function assertAllowedProtocol(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(`仅支持 http/https 协议（收到 ${url.protocol}）`)
  }
}

/**
 * @returns {{status:number, ok:boolean, headers:Record<string,string>, text:string, url:string, insecure:boolean}}
 */
export async function fetchBounded(rawUrl, options = {}) {
  const opts = { ...DEFAULTS, ...options }
  let url
  try {
    url = new URL(String(rawUrl))
  } catch {
    throw new HttpError('URL 不合法')
  }
  assertAllowedProtocol(url)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), opts.timeoutMs)
  let res
  try {
    res = await fetch(url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      redirect: opts.redirect,
      signal: controller.signal,
    })
  } catch (err) {
    const aborted = controller.signal.aborted
    clearTimeout(timer)
    if (aborted && opts.redirect === 'error') {
      throw new HttpError('请求超时或被重定向拒绝（凭据请求不允许跨源重定向）', { status: 0 })
    }
    if (aborted) throw new HttpError(`请求超时（>${Math.round(opts.timeoutMs / 1000)}s）`)
    throw new HttpError(`网络请求失败：${err?.cause?.code || err?.code || err?.message || '未知网络错误'}`)
  }

  // 流式读取并施加体积上限
  let received = 0
  try {
    if (res.body) {
      const reader = res.body.getReader()
      const chunks = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > opts.maxBytes) {
          controller.abort(new Error('too large'))
          throw new HttpError(`响应超过大小上限（${Math.round(opts.maxBytes / 1024)}KB）`, { status: res.status })
        }
        chunks.push(value)
      }
      const total = new Uint8Array(received)
      let offset = 0
      for (const c of chunks) {
        total.set(c, offset)
        offset += c.byteLength
      }
      const headers = {}
      res.headers.forEach((v, k) => { headers[k] = v })
      clearTimeout(timer)
      // 二进制模式：原始字节直接返回（utf8 解码会破坏图片数据）
      if (opts.binary) {
        return {
          status: res.status,
          ok: res.ok,
          headers,
          buffer: Buffer.from(total),
          url: res.url || url.toString(),
          insecure: url.protocol === 'http:',
        }
      }
      const decoder = new TextDecoder('utf-8', { fatal: false })
      return {
        status: res.status,
        ok: res.ok,
        headers,
        text: decoder.decode(total),
        url: res.url || url.toString(),
        insecure: url.protocol === 'http:',
      }
    }
    // 理论上 Node fetch 始终有 body；兜底
    const text = await res.text()
    if (text.length > opts.maxBytes) {
      throw new HttpError(`响应超过大小上限（${Math.round(opts.maxBytes / 1024)}KB）`, { status: res.status })
    }
    const headers = {}
    res.headers.forEach((v, k) => { headers[k] = v })
    clearTimeout(timer)
    return { status: res.status, ok: res.ok, headers, text, url: res.url || url.toString(), insecure: url.protocol === 'http:' }
  } catch (err) {
    clearTimeout(timer)
    if (err instanceof HttpError) throw err
    if (controller.signal.aborted) throw new HttpError(`响应超过大小上限（${Math.round(opts.maxBytes / 1024)}KB）`, { status: res.status })
    throw new HttpError(`读取响应失败：${err?.message || '未知错误'}`)
  }
}

export async function fetchJson(rawUrl, options = {}) {
  const res = await fetchBounded(rawUrl, options)
  if (!res.ok) {
    throw new HttpError(`HTTP ${res.status}`, { status: res.status })
  }
  try {
    return JSON.parse(res.text)
  } catch {
    throw new HttpError('响应不是有效的 JSON', { status: res.status })
  }
}
