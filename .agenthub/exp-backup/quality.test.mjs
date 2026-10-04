/**
 * quality.js 判定测试
 *
 * 样本全部取自 2026-09-29 的**两次真实运行**：
 *   - 失败样本 → .agenthub/runs/mcp-1790668720650.json（报 3/3 成功，产出全是废的）
 *   - 成功样本 → .agenthub/runs/mcp-1790668805804.json（答案链 alpha/bravo/charlie/bavo/5）
 * 刻意不放造出来的样本 —— 用真实数据才能验证规则是否真的贴合现实。
 */
import assert from 'node:assert/strict'
import { judgeOutput } from '../src/engine/quality.js'

let pass = 0
let fail = 0
const t = (name, fn) => {
  try {
    fn()
    console.log('  ok   ' + name)
    pass++
  } catch (e) {
    console.log('  FAIL ' + name + '\n       ' + e.message)
    fail++
  }
}

// ==== 真实失败样本（第一次 run_plan，prompt 被换行截断）====
const FAILED_S1 =
  '你这条消息只有标题「任务总目标」，还没有具体内容。\n\n请把完整目标、约束和期望产出补全，我再按你的要求执行。'
const FAILED_S2 =
  '收到，但您的消息中【任务总目标】后面是空的——还没有具体的任务内容。\n\n请补充说明您想完成的目标，例如：\n' +
  '- 要实现的功能或要修复的问题\n- 涉及的模块/文件（如有）\n- 验收标准或期望效果\n\n' +
  '另外我可以先简单了解一下 `D:\\app\\AgentHub` 这个项目的结构，如果您希望我先熟悉代码库，请告诉我。'

// ==== 真实成功样本（第二次 run_plan，答案链正确）====
const OK_S1 = 'alpha bravo charlie'
const OK_S2 = 'bravo'
const OK_S3 = '5' // 1 个字符 —— 合法答案，绝不能被标可疑

console.log('\n[应判可疑] 真实失败样本')
t('s1 cursor：要求补充目标与内容', () => {
  const r = judgeOutput(FAILED_S1, { status: 'ok' })
  assert.equal(r.level, 'suspect')
  assert.deepEqual(r.codes, ['template-refusal'])
})
t('s2 qoder：称消息里是空的', () => {
  const r = judgeOutput(FAILED_S2, { status: 'ok' })
  assert.equal(r.level, 'suspect')
  assert.deepEqual(r.codes, ['template-refusal'])
})

console.log('\n[应判正常] 真实成功样本')
t('s1 "alpha bravo charlie"', () => {
  assert.equal(judgeOutput(OK_S1, { status: 'ok' }).level, 'ok')
})
t('s2 "bravo"', () => {
  assert.equal(judgeOutput(OK_S2, { status: 'ok' }).level, 'ok')
})
t('s3 "5"（1 字符合法答案，防误报的关键用例）', () => {
  assert.equal(judgeOutput(OK_S3, { status: 'ok' }).level, 'ok')
})

console.log('\n[边界]')
t('空产出 / 纯空白 → suspect:empty', () => {
  assert.equal(judgeOutput('', { status: 'ok' }).level, 'suspect')
  assert.deepEqual(judgeOutput('   ', { status: 'ok' }).codes, ['empty'])
})
t('status=failed 时不再二次判定', () => {
  assert.equal(judgeOutput(FAILED_S1, { status: 'failed' }).level, 'ok')
})
t('未登录 → suspect:env-error', () => {
  const r = judgeOutput('Not logged in · Please run /login', { status: 'ok' })
  assert.equal(r.level, 'suspect')
  assert.deepEqual(r.codes, ['env-error'])
})
t('目录未受信 → suspect:env-error', () => {
  const r = judgeOutput('⚠ Workspace Trust Required\n\n  Do you trust the contents of this directory?', { status: 'ok' })
  assert.equal(r.level, 'suspect')
  assert.deepEqual(r.codes, ['env-error'])
})

console.log('\n[防误报] 长文档里正常引用这些措辞')
t('长文里出现 "not logged in"', () => {
  const doc = '这是一份很长的技术文档，用于说明排障流程。'.repeat(25) + ' 常见报错包括 not logged in、command not found 等。'
  assert.ok(doc.length > 400, '样本应超过 400 字符，实际 ' + doc.length)
  assert.equal(judgeOutput(doc, { status: 'ok' }).level, 'ok')
})
t('长文里出现 "请补充"', () => {
  const doc = '以下是接口设计说明。'.repeat(100) + ' 当参数缺失时，前端应提示用户请补充必要的信息。'
  assert.ok(doc.length > 800, '样本应超过 800 字符，实际 ' + doc.length)
  assert.equal(judgeOutput(doc, { status: 'ok' }).level, 'ok')
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
