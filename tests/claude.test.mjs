/**
 * claude 适配器的 payload 判定测试
 *
 * 运行：node --test tests/claude.test.mjs
 *
 * 为什么单独测这一层：
 * `claude --output-format json` 在「达到最大轮次」「API 错误」这些情况下
 * **仍然可能以退出码 0 结束**，真实信号只存在于 payload 里。
 * 如果这段判定漏了一种形态，整条保护就失效了 —— 而它失效的表现不是报错，
 * 是安静地把一次失败运行记成 status:'ok'。**安静失效的东西必须直接测。**
 *
 * 所以把判定抽成了纯函数 `isErrorPayload(payload)`：不用 mock 子进程，直接喂样本。
 * 下面的"正常样本"取自真实运行记录（.agenthub/runs/mcp-1790668720650.json 的 s3），
 * 字段名与取值都是 claude 实际吐出来的，不是照文档编的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { isErrorPayload } from '../src/adapters/claude.js'

/** 真实正常 payload（字段与取值照抄真实运行，正文已替换） */
const REAL_OK_PAYLOAD = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '已按要求完成，测试 37/37 全绿。',
  permission_denials: [],
  num_turns: 3,
  stop_reason: 'end_turn',
  total_cost_usd: 0.2056,
  session_id: '00000000-0000-0000-0000-000000000000',
  usage: { input_tokens: 100, output_tokens: 200 },
}

// ------------------------------------------------------------ 该判 error 的

test('真实正常样本 → 不判为错误（防误报的基准）', () => {
  assert.equal(isErrorPayload(REAL_OK_PAYLOAD), false)
})

test('★ error_max_turns：退出码是 0，只有 is_error 能说明它没干完', () => {
  const p = { type: 'result', subtype: 'error_max_turns', is_error: true, result: '已达到最大轮次' }
  assert.equal(isErrorPayload(p), true)
})

test('★ api_error：type 直接是 error，没有 subtype', () => {
  const p = { type: 'error', error: { type: 'api_error', message: 'Internal server error' } }
  assert.equal(isErrorPayload(p), true)
})

test('subtype 以 error 开头、但缺 is_error 字段时也要判出来', () => {
  // 不能把整层保护押在 is_error 一个字段上 —— CLI 版本会变
  assert.equal(isErrorPayload({ type: 'result', subtype: 'error_during_execution' }), true)
  assert.equal(isErrorPayload({ type: 'result', subtype: 'error_max_budget_usd' }), true)
})

test('★ is_error 与 subtype=success 同时出现时，以 is_error 为准', () => {
  // 反直觉但真实存在：subtype 说成功，is_error 说失败。宁可相信 is_error。
  assert.equal(isErrorPayload({ type: 'result', subtype: 'success', is_error: true }), true)
})

// ------------------------------------------------------------ 不该误报的

test('防误报：payload 正文里出现 error / 报错字样，不算 payload 出错', () => {
  // 正则锚在 subtype 上，不扫正文 —— 否则任何讲排障的长文档都会中招
  const p = {
    ...REAL_OK_PAYLOAD,
    result: '常见报错包括 api_error、Internal server error、Not logged in 等，见下文排障流程。',
  }
  assert.equal(isErrorPayload(p), false)
})

test('防误报：subtype 是 success 但 is_error 缺失 → 不判', () => {
  const p = { type: 'result', subtype: 'success', result: 'ok' }
  assert.equal(isErrorPayload(p), false)
})

test('非对象输入不炸，且一律不判', () => {
  for (const v of [null, undefined, '', 'error', 42, [], true]) {
    assert.equal(isErrorPayload(v), false, `输入 ${JSON.stringify(v)} 不应判 error`)
  }
})

// ------------------------------------------------------------ 已知边界（如实记下，不假装覆盖）

test('已知边界：is_error 为字符串 "true" 时不判（用的是严格 === true）', () => {
  // 现状：只认布尔 true。若哪天 CLI 改成字符串，这里会漏 —— 漏报比误报安全，先记着。
  assert.equal(isErrorPayload({ is_error: 'true' }), false)
  assert.equal(isErrorPayload({ is_error: 1 }), false)
})

test('已知边界：subtype 只以 error 开头就命中，不校验完整词', () => {
  // `errorfree` 这种词也会命中。现实中 claude 的 subtype 只有 success / error_* 几种，
  // 目前无风险；写下来是为了将来 subtype 扩充时有人能想起这条。
  assert.equal(isErrorPayload({ subtype: 'errorfree' }), true)
})
