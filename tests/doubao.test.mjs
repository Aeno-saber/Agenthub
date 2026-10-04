/**
 * 豆包 REST 适配器测试
 *
 * 全部用 mock fetch —— 不发真实网络请求，所以离线也能跑、也不花钱。
 * 真实冒烟（需要 ARK_API_KEY）单独在 docs 里记录，不进单元测试。
 *
 * 重点不是"能调通"，而是：
 *   - 没有 key 时**不能崩**，而且要给出人能照着做的提示；
 *   - 各类 HTTP 错误要翻译成人话，且保留服务端原文（便于排查）；
 *   - 请求体的拼装正确（model / messages / Authorization / thinking 是否该下发）。
 */
import process from 'node:process'
import assert from 'node:assert/strict'
import { DoubaoAdapter } from '../src/adapters/doubao.js'

let pass = 0
let fail = 0
const t = async (name, fn) => {
  try {
    await fn()
    console.log('  ok   ' + name)
    pass++
  } catch (e) {
    console.log('  FAIL ' + name + '\n       ' + (e.message || e))
    fail++
  }
}

const mkSpec = (over = {}) => ({
  id: 'doubao',
  name: '豆包',
  adapter: 'doubao',
  model: 'test-model',
  baseUrl: 'https://example.invalid/api/v3',
  ...over,
})

/** 临时替换 globalThis.fetch，跑完恢复（避免污染其他测试文件） */
const withFetch = async (impl, fn) => {
  const orig = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = orig
  }
}

const jsonResponse = (status, obj) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(obj),
})

/** 每个用例前后清掉 key，避免相互串味 */
const clearKeys = () => {
  delete process.env.ARK_API_KEY
  delete process.env.DOUBAO_API_KEY
  delete process.env.ARK_BASE_URL
  delete process.env.DOUBAO_BASE_URL
  delete process.env.ARK_MODEL
}

console.log('\n[无 key 降级] —— 这是最容易崩的路径')
await t('无 key：probe 返回 available:false，且提示里带上变量名', async () => {
  clearKeys()
  const r = await new DoubaoAdapter(mkSpec()).probe()
  assert.equal(r.available, false)
  assert.match(r.reason, /ARK_API_KEY/)
  assert.match(r.reason, /console\.volcengine\.com/) // 给出到哪拿 key
})

await t('无 key：probe 不发任何网络请求', async () => {
  clearKeys()
  let called = false
  await withFetch(
    async () => {
      called = true
      return jsonResponse(200, {})
    },
    () => new DoubaoAdapter(mkSpec()).probe()
  )
  assert.equal(called, false)
})

await t('无 key：run 不崩，返回 failed 并说明原因', async () => {
  clearKeys()
  const r = await new DoubaoAdapter(mkSpec()).run({ prompt: '你好' })
  assert.equal(r.status, 'failed')
  assert.match(r.text, /ARK_API_KEY/)
  assert.equal(r.raw.exitCode, null)
  assert.deepEqual(r.cost, {})
})

console.log('\n[成功路径]')
await t('解析 choices[0].message.content 与 usage token 数', async () => {
  clearKeys()
  process.env.ARK_API_KEY = 'sk-test'
  const a = new DoubaoAdapter(mkSpec())
  const r = await withFetch(
    async (url, opts) => {
      assert.match(url, /\/chat\/completions$/)
      assert.equal(opts.method, 'POST')
      assert.equal(opts.headers.Authorization, 'Bearer sk-test')
      return jsonResponse(200, {
        choices: [{ message: { role: 'assistant', content: 'bravo' } }],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      })
    },
    () => a.run({ prompt: '取第二个单词' })
  )
  assert.equal(r.status, 'ok')
  assert.equal(r.text, 'bravo')
  assert.equal(r.cost.inputTokens, 11)
  assert.equal(r.cost.outputTokens, 3)
  // 不估美元成本：豆包按人民币计价，塞进 usd 会误导
  assert.equal(r.cost.usd, undefined)
  // REST 没有退出码，用 HTTP 状态码顶上
  assert.equal(r.raw.exitCode, 200)
  clearKeys()
})

await t('baseUrl 尾部斜杠被清理（不会拼出 //chat/completions）', async () => {
  clearKeys()
  process.env.ARK_API_KEY = 'sk-test'
  const a = new DoubaoAdapter(mkSpec({ baseUrl: 'https://example.invalid/api/v3/' }))
  let url = null
  await withFetch(
    async (u) => {
      url = u
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })
    },
    () => a.run({ prompt: 'x' })
  )
  assert.equal(url, 'https://example.invalid/api/v3/chat/completions')
  clearKeys()
})

await t('role 注入为 system message，且排在 user 前面', async () => {
  clearKeys()
  process.env.ARK_API_KEY = 'sk-test'
  let body = null
  await withFetch(
    async (u, o) => {
      body = JSON.parse(o.body)
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })
    },
    () => new DoubaoAdapter(mkSpec()).run({ prompt: '写文档', role: '文档书写' })
  )
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[0].role, 'system')
  assert.match(body.messages[0].content, /文档/)
  assert.equal(body.messages[1].role, 'user')
  assert.equal(body.messages[1].content, '写文档')
  clearKeys()
})

await t('无 role 时不塞空的 system message', async () => {
  clearKeys()
  process.env.ARK_API_KEY = 'sk-test'
  let body = null
  await withFetch(
    async (u, o) => {
      body = JSON.parse(o.body)
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })
    },
    () => new DoubaoAdapter(mkSpec()).run({ prompt: 'x' })
  )
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].role, 'user')
  clearKeys()
})

console.log('\n[thinking 字段]')
await t('thinking 默认不下发（老的 doubao-pro 系不认这个字段，发了会 400）', async () => {
  clearKeys()
  process.env.ARK_API_KEY = 'sk-test'
  let body = null
  await withFetch(
    async (u, o) => {
      body = JSON.parse(o.body)
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })
    },
    () => new DoubaoAdapter(mkSpec()).run({ prompt: 'x' })
  )
  assert.equal('thinking' in body, false)
  clearKeys()
})

await t('配置了 thinking 才下发', async () => {
  clearKeys()
  process.env.ARK_API_KEY = 'sk-test'
  let body = null
  await withFetch(
    async (u, o) => {
      body = JSON.parse(o.body)
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })
    },
    () => new DoubaoAdapter(mkSpec({ thinking: 'disabled' })).run({ prompt: 'x' })
  )
  assert.deepEqual(body.thinking, { type: 'disabled' })
  clearKeys()
})

console.log('\n[HTTP 错误翻译]')
for (const [status, expectRe] of [
  [401, /无效或已过期/],
  [403, /未在方舟控制台开通/],
  [404, /Model ID 不对/], // 服务端原文里没有 "has not activated"，应落到「名字不对」分支
  [429, /限流或账户余额不足/],
  [500, /服务端错误/],
]) {
  await t(`HTTP ${status} → 翻译成人话，且保留服务端原文`, async () => {
    clearKeys()
    process.env.ARK_API_KEY = 'sk-test'
    const a = new DoubaoAdapter(mkSpec())
    const r = await withFetch(
      async () => jsonResponse(status, { error: { message: 'SERVER_SAYS_HI' } }),
      () => a.run({ prompt: 'x' })
    )
    assert.equal(r.status, 'failed')
    assert.match(r.text, expectRe)
    assert.match(r.text, /SERVER_SAYS_HI/) // 原文不能被吞掉，否则没法排查
    assert.equal(r.raw.exitCode, status)
    clearKeys()
  })
}

console.log('\n[404 的两种成因必须分开翻译]')
// 2026-09-29 实测：方舟对这两种情况给的是**不同**的错误原文。
// 混成一句「不存在或未开通」，会让人在「换个 ID 试试」和「去控制台开通」之间瞎试。
await t('账号没开通这个模型 → 提示去「开通管理」开通', async () => {
  clearKeys()
  process.env.ARK_API_KEY = 'sk-test'
  const r = await withFetch(
    async () =>
      jsonResponse(404, {
        error: {
          message:
            'Your account 2132542077 has not activated the model doubao-seed-2-1-pro-260628',
        },
      }),
    () => new DoubaoAdapter(mkSpec()).run({ prompt: 'x' })
  )
  assert.equal(r.status, 'failed')
  assert.match(r.text, /模型未开通/)
  assert.match(r.text, /开通管理/)
  clearKeys()
})

await t('Model ID 名字写错了 → 提示去核对 ID，且不能混成「未开通」', async () => {
  clearKeys()
  process.env.ARK_API_KEY = 'sk-test'
  const r = await withFetch(
    async () =>
      jsonResponse(404, {
        error: { message: 'The model or endpoint doubao-typo-123 does not exist' },
      }),
    () => new DoubaoAdapter(mkSpec()).run({ prompt: 'x' })
  )
  assert.equal(r.status, 'failed')
  assert.match(r.text, /Model ID 不对/)
  assert.doesNotMatch(r.text, /模型未开通/) // 别把两种原因混起来
  clearKeys()
})

console.log('\n[有 key 时的 probe]')
await t('probe 真发一次请求（这是唯一能验证「key 有效 + 模型已开通」的办法）', async () => {
  clearKeys()
  process.env.ARK_API_KEY = 'sk-test'
  let called = false
  let body = null
  const r = await withFetch(
    async (u, o) => {
      called = true
      body = JSON.parse(o.body)
      return jsonResponse(200, { choices: [{ message: { content: '' } }] })
    },
    () => new DoubaoAdapter(mkSpec()).probe()
  )
  assert.equal(called, true)
  assert.equal(body.max_tokens, 1) // 探活必须极省
  assert.equal(r.available, true)
  assert.match(r.version, /REST/)
  clearKeys()
})

await t('key 有效但模型未开通 → 判为不可用（而不是误判可用）', async () => {
  clearKeys()
  process.env.ARK_API_KEY = 'sk-test'
  const r = await withFetch(
    async () => jsonResponse(403, { error: { message: 'model not activated' } }),
    () => new DoubaoAdapter(mkSpec()).probe()
  )
  assert.equal(r.available, false)
  assert.match(r.reason, /未在方舟控制台开通/)
  clearKeys()
})

await t('网络异常：probe 不抛异常，返回「网络不可达」', async () => {
  clearKeys()
  process.env.ARK_API_KEY = 'sk-test'
  const r = await withFetch(
    async () => {
      throw new Error('ECONNREFUSED')
    },
    () => new DoubaoAdapter(mkSpec()).probe()
  )
  assert.equal(r.available, false)
  assert.match(r.reason, /网络不可达/)
  clearKeys()
})

await t('网络异常：run 也不抛，返回 failed', async () => {
  clearKeys()
  process.env.ARK_API_KEY = 'sk-test'
  const r = await withFetch(
    async () => {
      throw new Error('ECONNREFUSED')
    },
    () => new DoubaoAdapter(mkSpec()).run({ prompt: 'x' })
  )
  assert.equal(r.status, 'failed')
  assert.match(r.text, /请求失败/)
  clearKeys()
})

console.log('\n[key 与模型的来源优先级]')
await t('key 优先级：成员配置 env 覆盖进程环境变量', async () => {
  clearKeys()
  process.env.ARK_API_KEY = 'from-process'
  let auth = null
  await withFetch(
    async (u, o) => {
      auth = o.headers.Authorization
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })
    },
    () => new DoubaoAdapter(mkSpec({ env: { ARK_API_KEY: 'from-spec' } })).run({ prompt: 'x' })
  )
  assert.equal(auth, 'Bearer from-spec')
  clearKeys()
})

await t('未配 model 时回退到内置默认 Model ID', async () => {
  clearKeys()
  process.env.ARK_API_KEY = 'sk-test'
  let body = null
  await withFetch(
    async (u, o) => {
      body = JSON.parse(o.body)
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })
    },
    () => new DoubaoAdapter(mkSpec({ model: undefined })).run({ prompt: 'x' })
  )
  assert.match(body.model, /^doubao-/)
  clearKeys()
})

await t('spec.model 优先于环境变量 ARK_MODEL', async () => {
  clearKeys()
  process.env.ARK_API_KEY = 'sk-test'
  process.env.ARK_MODEL = 'from-env'
  let body = null
  await withFetch(
    async (u, o) => {
      body = JSON.parse(o.body)
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })
    },
    () => new DoubaoAdapter(mkSpec({ model: 'from-spec' })).run({ prompt: 'x' })
  )
  assert.equal(body.model, 'from-spec')
  clearKeys()
})

await t('DOUBAO_API_KEY 作为 ARK_API_KEY 的别名（Trae 用的就是这个名字）', async () => {
  clearKeys()
  process.env.DOUBAO_API_KEY = 'alias-key'
  let auth = null
  await withFetch(
    async (u, o) => {
      auth = o.headers.Authorization
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })
    },
    () => new DoubaoAdapter(mkSpec()).run({ prompt: 'x' })
  )
  assert.equal(auth, 'Bearer alias-key')
  clearKeys()
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
