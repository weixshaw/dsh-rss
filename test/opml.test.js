import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseOpml, dedupeFeeds, buildOpml } from '../lib/opml.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const opml = readFileSync(join(fixtures, 'opml-nested.xml'), 'utf8')

test('parseOpml: 嵌套分组路径', () => {
  const { feeds, skipped } = parseOpml(opml)
  assert.equal(skipped, 1) // ftp 协议被跳过
  const zxx = feeds.find((f) => f.title === '张鑫旭博客')
  assert.equal(zxx.group, '技术/前端')
  assert.equal(zxx.xmlUrl, 'https://www.zhangxinxu.com/wordpress/feed')
  const ruan = feeds.find((f) => f.title === '阮一峰周刊')
  assert.equal(ruan.group, '技术')
  const none = feeds.find((f) => f.title === '无分组源')
  assert.equal(none.group, '')
})

test('dedupeFeeds: 规范化 URL 去重', () => {
  const { feeds } = parseOpml(opml)
  const dedup = dedupeFeeds(feeds)
  // “重复源”与“无分组源”规范化后相同（大小写、末尾斜杠）
  assert.equal(dedup.feeds.length, 3)
  assert.equal(dedup.duplicates, 1)
})

test('buildOpml → parseOpml 往返一致（含引号转义）', () => {
  const feeds = [
    { title: '带"引号"的<源>', xmlUrl: 'https://a.example/feed', siteUrl: 'https://a.example', group: '分组/子组' },
    { title: '普通源', xmlUrl: 'https://b.example/feed', group: '' },
  ]
  const xml = buildOpml(feeds)
  const parsed = parseOpml(xml)
  const a = parsed.feeds.find((f) => f.xmlUrl === 'https://a.example/feed')
  const b = parsed.feeds.find((f) => f.xmlUrl === 'https://b.example/feed')
  assert.equal(a.title, '带"引号"的<源>')
  assert.equal(a.group, '分组/子组')
  assert.equal(a.htmlUrl, 'https://a.example/') // normalizeFeedUrl 保留根路径斜杠
  assert.equal(b.group, '')
  assert.equal(parsed.skipped, 0)
})

test('parseOpml: 非 OPML 抛错', () => {
  assert.throws(() => parseOpml('<html></html>'), /OPML/)
})
