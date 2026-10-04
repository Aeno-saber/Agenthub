/**
 * quality.js 判定测试
 *
 * 样本全部取自 2026-09-29 的**两次真实运行**：
 *   - 失败样本 → .agenthub/runs/mcp-1790668720650.json（报 3/3 成功，产出全是废的）
 *   - 成功样本 → .agenthub/runs/mcp-1790668805804.json（答案链 alpha/bravo/charlie/bavo/5）
 * 刻意不放造出来的样本 —— 用真实数据才能验证规则是否真的贴合现实。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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

// ==== 结构化信号：permission_denials（2026-09-29 补）====
//
// 用例全部取自**真跑留下的原始证据**：.agenthub/runs/run-1790658473692.json。
// 那次运行报「3/3 成功 · 0 失败」，而三个成员的产出全是
// 「测试文件已写好，但命令被 `This command requires approval` 拦住、没真正执行」。
//
// 现有 19 条正则一条都拦不住，而且**加词也没用** —— 那三条产出是 1027 / 587 / 475 字符，
// **全部超过环境词的 400 长度门**。唯一能识别的是 `permission_denials` 这个结构化字段。
// 这一组测的就是：规则不依赖文本长度，靠引擎手里的硬事实。

console.log('\n[结构化信号] permission_denials（真实运行证据）')

/*
 * 夹具落在 tests/fixtures/（**进版本库**），而不是原始的 .agenthub/runs/。
 *
 * 原先这里直接读 `.agenthub/runs/run-1790658473692.json`。但那个目录写在 .gitignore 里
 * （它确实是运行产物），于是换台机器、或者 CI 上跑，文件根本不存在 ——
 * 整组断言走"跳过"分支，然后 exit 0 收场：**没跑过的测试报了绿**。
 * 这正是这一轮一直在修的"假绿"，只不过这次长在测试自己身上。
 *
 * 现在改成：夹具缺失 = **硬失败**。没法验证的东西不算通过。
 * 夹具由 .agenthub/runs/run-1790658473692.json 抽取（text 与 permission_denials 逐字保留）。
 */
const FIXTURE = fileURLToPath(new URL('./fixtures/run-permission-denials.json', import.meta.url))
let realEntries = null
try {
  realEntries = JSON.parse(readFileSync(FIXTURE, 'utf8')).entries
} catch (e) {
  console.log(`  FAIL 夹具读取失败（${FIXTURE}）：${e.message}`)
  fail++
}

if (!Array.isArray(realEntries) || !realEntries.length) {
  if (fail === 0) {
    fail++
    console.log('  FAIL 夹具为空或结构不符 —— 这一组断言无法验证，不当作通过')
  }
} else {
  const byId = Object.fromEntries(realEntries.map((e) => [e.id, e]))
  const denialsOf = (id) => {
    try { return JSON.parse(byId[id].raw.stdout).permission_denials || [] } catch { return [] }
  }

  t('前置：样本的 status 确实是 ok，且确实存在被拦下的命令', () => {
    assert.equal(byId.s2.status, 'ok', '这个样本"假"就假在 status 是 ok')
    assert.ok(denialsOf('s2').length > 0, 's2 应有被权限拦下的命令')
    assert.equal(denialsOf('s3').length, 0, 's3 没有被拦的命令 —— 这条注定覆盖不到，先记下来')
  })

  t('★ s1：1027 字符的产出 —— 超过 400 长度门，正则拦不住、结构化信号能拦', () => {
    const text = byId.s1.text
    assert.ok(text.length > 400, `样本应超过 400 字符，实际 ${text.length}`)
    // 先确认"只看文本"确实抓不住（这正是当初漏判的原因）
    assert.equal(judgeOutput(text, { status: 'ok' }).level, 'ok')
    // 补上结构化信号就抓住了
    const r = judgeOutput(text, { status: 'ok', permissionDenials: denialsOf('s1') })
    assert.equal(r.level, 'suspect')
    assert.deepEqual(r.codes, ['not-executed'])
  })

  t('★ s2：587 字符的产出，同样只有结构化信号能识别', () => {
    const text = byId.s2.text
    assert.equal(judgeOutput(text, { status: 'ok' }).level, 'ok')
    const r = judgeOutput(text, { status: 'ok', permissionDenials: denialsOf('s2') })
    assert.equal(r.level, 'suspect')
    assert.deepEqual(r.codes, ['not-executed'])
  })

  t('防误报：有被拦的命令、但产出是正常结果 → 不判（可能只是换个方式跑成了）', () => {
    const r = judgeOutput('测试已通过：37/37 全绿，`node --test tests/*.test.mjs` 跑了两遍。', {
      status: 'ok',
      permissionDenials: denialsOf('s2'),
    })
    assert.equal(r.level, 'ok', '光有 denials 不足以定罪 —— 产出还得自己也承认没干成')
  })

  t('防误报：文本自称没执行、但没有结构化证据 → 不判（文本会撒谎，证据不会）', () => {
    assert.equal(judgeOutput(byId.s1.text, { status: 'ok' }).level, 'ok')
    assert.equal(judgeOutput(byId.s2.text, { status: 'ok' }).level, 'ok')
  })

  t('已知边界：s3 的 denials 为空 → 本规则覆盖不到它（宁漏勿误，如实记下）', () => {
    const r = judgeOutput(byId.s3.text, { status: 'ok', permissionDenials: denialsOf('s3') })
    assert.equal(r.level, 'ok', '这条是已知漏判，写进测试而不是假装能覆盖')
  })

  // ==== claimed-edit-no-change：上游评审差点写成一条恒定误报的规则 ====
  //
  // 上游两份评审（.agenthub/real-run/outputs-run3/s2-qoder.md、s3-claude.md）都把这条列为
  // "真缺口"，建议写法是「文本命中完成语 && changedFiles.length === 0 && 权限档非只读」。
  //
  // 写法本身没错，但**没人去核实 changedFiles 是否真的被填过**。
  // 核实结果：`.agenthub/runs/*.json` 全部 13 个条目的 changedFiles 都是 `[]` ——
  // 三个适配器全都硬编码返回空数组，从来没有任何一个填过它。
  // 照抄那个写法，这条规则会在**每一次写档运行**上误报（只要正文出现"已修改"）。
  //
  // 所以实现上多了道安全带：只有 `changedFiles` 是**数组**（= 确实采集过）才采信。
  // 下面这组测试就是钉住这道安全带 —— 它比规则本身更值钱。

  console.log('\n[claimed-edit-no-change] 声称改了、但采集到的改动为空')

  t('★ 规则生效：写档 + 采集到空改动 + 正文声称已写 → suspect', () => {
    const r = judgeOutput(byId.s1.text, { status: 'ok', changedFiles: [], permission: 'execute' })
    assert.equal(r.level, 'suspect')
    assert.deepEqual(r.codes, ['claimed-edit-no-change'])
  })

  t('★★ 防误报（核心）：真实产出 + changedFiles 未采集(null) → 不判', () => {
    // 这正是上游建议会踩的坑：真实产出确实写着「测试文件已写好」，
    // 若把 null/未采集也当成"零改动"，这条规则就是 100% 误报。
    const r = judgeOutput(byId.s1.text, { status: 'ok', changedFiles: null, permission: 'execute' })
    assert.equal(r.level, 'ok', '「没采集」不等于「没有改动」—— 不能拿没数据去定罪')
  })

  t('防误报：undefined（调用点压根没传这个字段）→ 不判', () => {
    assert.equal(judgeOutput(byId.s1.text, { status: 'ok', permission: 'execute' }).level, 'ok')
    assert.equal(judgeOutput(byId.s2.text, { status: 'ok', permission: 'execute' }).level, 'ok')
  })

  t('防误报：只读/计划档 → 零改动是正常的，不判', () => {
    for (const perm of ['readonly', 'plan']) {
      const r = judgeOutput(byId.s1.text, { status: 'ok', changedFiles: [], permission: perm })
      assert.equal(r.level, 'ok', `${perm} 档本就只出结论，不该判`)
    }
  })

  t('防误报：正文没说改动过 → 即使写档 + 空改动也不判', () => {
    // s3 那份产出是纯评审（"覆盖模块""状态：尚未实际执行"），不含完成语
    const r = judgeOutput(byId.s3.text, { status: 'ok', changedFiles: [], permission: 'execute' })
    assert.equal(r.level, 'ok')
  })

  t('防误报：采集到非空改动 → 不判', () => {
    const r = judgeOutput(byId.s1.text, {
      status: 'ok',
      changedFiles: ['tests/plan.test.mjs'],
      permission: 'execute',
    })
    assert.equal(r.level, 'ok')
  })
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
