import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AiClient, AiError } from '../lib/ai.js'

function fakeAi(choose) {
  const calls = []
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts })
    return choose({ url, opts })
  }
  return { calls, fetchImpl }
}

function okRes(text) {
  return { status: 200, ok: true, headers: {}, text: JSON.stringify({ choices: [{ message: { content: text } }] }), insecure: false }
}

function clientWith(fetchImpl, over = {}) {
  return new AiClient({ baseUrl: 'https://ai.test/v1', apiKey: 'sk-secret', model: 'test-model', fetchImpl, ...over })
}

test('baseUrl 规范化：自动补 /v1；Key 走 Bearer；禁用重定向', async () => {
  const { calls, fetchImpl } = fakeAi(() => okRes('好的'))
  const c = new AiClient({ baseUrl: 'https://ai.test', apiKey: 'sk-secret', model: 'm', fetchImpl })
  const out = await c.chat({ system: 's', user: 'u' })
  assert.equal(out, '好的')
  assert.equal(calls[0].url, 'https://ai.test/v1/chat/completions')
  assert.equal(calls[0].opts.headers.authorization, 'Bearer sk-secret')
  assert.equal(calls[0].opts.redirect, 'error')
  const body = JSON.parse(String(calls[0].opts.body))
  assert.equal(body.model, 'm')
  assert.equal(body.stream, false)
  assert.equal(body.messages[0].role, 'system')
})

test('summarize: 不可信内容定界 + 截断 + 中文系统提示', async () => {
  const { calls, fetchImpl } = fakeAi(() => okRes('一句话摘要'))
  const c = clientWith(fetchImpl)
  const long = 'A'.repeat(15000)
  const out = await c.summarize({ title: 'T', contentText: long })
  assert.equal(out, '一句话摘要')
  const body = JSON.parse(String(calls[0].opts.body))
  assert.match(body.messages[0].content, /不可信/)
  assert.match(body.messages[1].content, /<<<ARTICLE/)
  assert.match(body.messages[1].content, /\n>>>/)
  assert.ok(body.messages[1].content.length < 15000) // 已截断
})

test('ask: 携带问题；空问题报错', async () => {
  const { calls, fetchImpl } = fakeAi(() => okRes('回答'))
  const c = clientWith(fetchImpl)
  const out = await c.ask({ title: 'T', contentText: '正文', question: '这篇讲了什么？' })
  assert.equal(out, '回答')
  const body = JSON.parse(String(calls[0].opts.body))
  assert.match(body.messages[1].content, /这篇讲了什么/)
  await assert.rejects(() => c.ask({ title: 'T', contentText: 'x', question: '' }), AiError)
})

test('错误脱敏：401 与异常响应不包含 API Key', async () => {
  const { fetchImpl } = fakeAi(({ url }) => {
    if (url.includes('/chat/completions')) {
      return { status: 401, ok: false, headers: {}, text: 'invalid sk-secret key', insecure: false }
    }
    return okRes('')
  })
  const c = clientWith(fetchImpl)
  await assert.rejects(() => c.chat({ system: 's', user: 'u' }), (err) => {
    assert.match(err.message, /认证失败/)
    assert.ok(!err.message.includes('sk-secret'))
    return true
  })
})

test('构造校验：缺 Key / 缺模型 / 非法协议', async () => {
  assert.throws(() => new AiClient({ baseUrl: 'https://ai.test', apiKey: '', model: 'm', fetchImpl: async () => okRes('') }), /Key/)
  assert.throws(() => new AiClient({ baseUrl: 'https://ai.test', apiKey: 'k', model: '', fetchImpl: async () => okRes('') }), /模型/)
  assert.throws(() => new AiClient({ baseUrl: 'ftp://ai.test', apiKey: 'k', model: 'm', fetchImpl: async () => okRes('') }), /http\/https/)
})

test('非文本回复与空回复报错', async () => {
  const empty = fakeAi(() => okRes(''))
  await assert.rejects(() => clientWith(empty.fetchImpl).chat({ system: 's', user: 'u' }), /未返回文本/)
  const badJson = fakeAi(() => ({ status: 200, ok: true, headers: {}, text: 'not json', insecure: false }))
  await assert.rejects(() => clientWith(badJson.fetchImpl).chat({ system: 's', user: 'u' }), /JSON/)
})
