import { mkdir, readFile, writeFile, rename, chmod, unlink, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { RssError, sha1 } from './util.js'

/**
 * 图片本地代理的缓存与校验（参考 qiaomu-ai-rss 的 LocalImages 语义，独立实现）：
 * - 只接受魔数嗅探认可的光栅图片格式（png/jpeg/gif/webp/avif/bmp/ico）；
 *   **SVG 一律拒绝**——SVG 能携带脚本，直接在插件源上打开会以本源执行（XSS）。
 * - 磁盘缓存：media/<sha1(url)>.img（0600、原子写），LRU 上限 100 文件 / 64MB；
 *   缓存写入失败只影响下次命中，不阻断本次返回。
 * - 同一 URL 的在途请求去重（并发渲染同一图只发一次网络请求）。
 * 浏览器端 <img> 加载走 /dsh-rss/media 本地路由：远端图床看不到客户端 IP/UA/Referer。
 */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_CACHE_FILES = 100
const MAX_CACHE_BYTES = 64 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15000

export const MEDIA_LIMITS = { MAX_IMAGE_BYTES, MAX_CACHE_FILES, MAX_CACHE_BYTES }

/** 魔数嗅探：返回 image/* MIME；无法识别（含 SVG/HTML 等）返回 null。 */
export function imageMime(buf) {
  if (!buf || buf.length < 12) return null
  const b = buf
  const ascii = (start, len) => String.fromCharCode(...b.subarray(start, start + len))
  if (b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'
  if (ascii(4, 4) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 4))) return 'image/avif'
  if (ascii(0, 2) === 'BM') return 'image/bmp'
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon'
  return null
}

export class MediaError extends RssError {
  constructor(message, status = 502) {
    super(message, { status })
    this.name = 'MediaError'
  }
}

export class MediaCache {
  constructor(dir) {
    this.dir = dir
    this.pending = new Map() // url -> Promise<{buffer,mime}>
  }

  _fileOf(url) {
    return join(this.dir, `${sha1(url)}.img`)
  }

  /** 命中缓存：读取 + 嗅探；损坏（无法识别）则删除并视为未命中。 */
  async lookup(url) {
    let data
    try {
      data = await readFile(this._fileOf(url))
    } catch {
      return null
    }
    const mime = imageMime(data)
    if (!mime) {
      await unlink(this._fileOf(url)).catch(() => {})
      return null
    }
    return { buffer: data, mime }
  }

  /** 抓取并缓存（在途去重）。失败上抛 MediaError（含面向路由的状态码）。 */
  fetch(url, fetchImpl) {
    const existing = this.pending.get(url)
    if (existing) return existing
    const run = this._fetch(url, fetchImpl).finally(() => this.pending.delete(url))
    this.pending.set(url, run)
    return run
  }

  async _fetch(url, fetchImpl) {
    let res
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'image/*,*/*;q=0.8', 'user-agent': 'Mozilla/5.0 (compatible; dsh-rss/0.3)' },
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBytes: MAX_IMAGE_BYTES,
        binary: true,
      })
    } catch (err) {
      throw new MediaError(`图片抓取失败：${err?.message || '网络错误'}`, 502)
    }
    if (res.status === 404 || res.status === 410) throw new MediaError('图片不存在（404）', 404)
    if (!res.ok) throw new MediaError(`图片源 HTTP ${res.status}`, 502)
    const buffer = Buffer.from(res.buffer || [])
    if (!buffer.length) throw new MediaError('图片源返回空内容', 502)
    const mime = imageMime(buffer)
    if (!mime) throw new MediaError('不支持的图片格式（仅 png/jpeg/gif/webp/avif/bmp/ico；拒绝 SVG）', 415)
    // 缓存写入尽力而为：失败不影响本次返回（但等待完成，保证调用方随后的 lookup 能命中）
    await this._store(url, buffer).catch(() => {})
    return { buffer, mime }
  }

  /** 原子写 + LRU 修剪（100 文件 / 64MB）。 */
  async _store(url, buffer) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    try { await chmod(this.dir, 0o700) } catch { /* 平台差异 */ }
    const file = this._fileOf(url)
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await writeFile(tmp, buffer, { mode: 0o600 })
    try { await chmod(tmp, 0o600) } catch { /* 尽力 */ }
    await rename(tmp, file)
    // LRU：按 mtime 新→旧累计，超限删除
    const names = (await readdir(this.dir)).filter((n) => n.endsWith('.img'))
    const entries = []
    for (const n of names) {
      const st = await stat(join(this.dir, n)).catch(() => null)
      if (st) entries.push({ name: n, mtime: st.mtimeMs, size: st.size })
    }
    entries.sort((a, b) => b.mtime - a.mtime)
    let total = 0
    const doomed = []
    for (let i = 0; i < entries.length; i++) {
      total += entries[i].size
      if (i >= MAX_CACHE_FILES || total > MAX_CACHE_BYTES) doomed.push(entries[i].name)
    }
    for (const n of doomed) await unlink(join(this.dir, n)).catch(() => {})
  }

  /** 查缓存 → 未命中则抓取（路由主入口）。 */
  async serve(url, fetchImpl) {
    const hit = await this.lookup(url)
    if (hit) return hit
    return this.fetch(url, fetchImpl)
  }
}
