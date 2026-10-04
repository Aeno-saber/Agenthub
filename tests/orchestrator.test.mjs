/**
 * orchestrator.js 单元测试 —— buildPrompt
 *
 * 运行：node --test tests/orchestrator.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPrompt, Orchestrator, resolveFailurePolicy, brokenDeps, FAILURE_POLICIES } from '../src/engine/orchestrator.js'

/** 默认 options：与 DEFAULT_OPTIONS 中的上游截断阈值保持一致 */
const opts = (extra = {}) => ({ upstreamExcerptChars: 4000, ...extra })

/** 造一个子任务，测试里只覆盖关心的字段 */
const st = (extra = {}) => ({
  id: 's1',
  memberId: 'claude',
  prompt: '做 s1',
  ...extra,
})

/** 造一个 ctx，results 可传入 */
const ctx = (results = {}, goal = '测试目标') => ({ plan: { goal }, results })

/*
 * 造一条"可用的上游结果"。
 *
 * ⚠️ `status: 'ok'` 不能省。buildPrompt 判定"这个上游到底有没有可用产出"时，
 * **只认 `status === 'ok'`** —— 没有 status 的一律当缺口处理（宁可对下游多说一句，
 * 也不放一个状态不明的上游混进上下文）。真实 entry 一定带 status
 * （runOne / markSkipped 都会写），所以夹具也必须带上，否则测的就不是真实形状。
 */
const upRes = (extra = {}) => ({ status: 'ok', ...extra })

// -------------------------------------------------------- 无依赖的基础拼装

test('buildPrompt：无依赖子任务只拼装目标、子任务、角色与结尾要求', () => {
  const out = buildPrompt(st({ role: '测试' }), ctx(), opts())
  assert.match(out, /【任务总目标】\n测试目标/)
  assert.match(out, /【本次子任务】\n做 s1/)
  assert.match(out, /【你的角色】测试/)
  assert.match(out, /【要求】直接产出结果，不要复述上面的说明文字。/)
  // 没有依赖时不应出现上游段落
  assert.ok(!out.includes('【上游产出，请基于它继续】'))
})

test('buildPrompt：没有 role 时不输出角色段落', () => {
  const out = buildPrompt(st(), ctx(), opts())
  assert.ok(!out.includes('【你的角色】'))
  assert.ok(out.includes('【本次子任务】'))
})

// --------------------------------------------------------------- 上游注入

test('buildPrompt：带上游产出时注入上下文块，含成员名与角色', () => {
  const results = {
    s1: upRes({ memberId: 'claude', memberName: '克劳德', role: '研究员', text: '上游产物正文' }),
  }
  const out = buildPrompt(st({ dependsOn: ['s1'] }), ctx(results), opts())
  assert.ok(out.includes('【上游产出，请基于它继续】'))
  assert.ok(out.includes('—— 来自子任务 s1（克劳德 / 研究员）——'))
  assert.ok(out.includes('上游产物正文'))
})

test('buildPrompt：上游缺 memberName 时回落到 memberId，缺 role 时回落到「执行者」', () => {
  const results = { s1: upRes({ memberId: 'gemini', text: '内容' }) }
  const out = buildPrompt(st({ dependsOn: ['s1'] }), ctx(results), opts())
  assert.ok(out.includes('（gemini / 执行者）'))
})

test('★ buildPrompt：依赖没有产出时**不再静默略过** —— 必须明说缺了什么', () => {
  /*
   * 这条测试原来叫「依赖存在但结果缺失时跳过，不产生上游段落」，
   * 断言的是"那段上游整块消失、不留痕迹"。
   *
   * 那个行为是错的：从下游的视角看，"我依赖的东西本来就不存在"，
   * 它照样会交出一份看起来完整、实则少了一块输入的结论 ——
   * 这就是「上游信号被丢掉」在 prompt 拼装层的同一副面孔。
   *
   * 现在改成：上游段落确实不出现（没内容就是没内容），
   * 但**必须**多出一段缺口说明，把"缺了谁"告诉下游。
   */
  const out = buildPrompt(st({ dependsOn: ['ghost'] }), ctx(), opts())
  assert.ok(!out.includes('【上游产出，请基于它继续】'), '没有可用产出就不该有上游正文段')
  assert.ok(out.includes('【⚠️ 上游有缺口，你的结论必须带上这个前提】'), '★ 缺口必须明说')
  assert.ok(out.includes('子任务 ghost：**没有产出**'), '要点名是哪一个缺了')
  assert.match(out, /不要假装它们的结果存在/)
})

test('★ buildPrompt：依赖执行失败 → 缺口说明里带上它的失败原因', () => {
  const results = {
    s1: upRes({ memberId: 'a', text: '正常产出' }),
    s2: { status: 'failed', memberId: 'b', memberName: 'B', text: '超时未返回\n后面还有一堆日志' },
  }
  const out = buildPrompt(st({ dependsOn: ['s1', 's2'] }), ctx(results), opts())
  // 好的那条照常注入
  assert.ok(out.includes('来自子任务 s1'))
  // 坏的那条进缺口段，且带上原因的第一行（不把整篇日志糊进去）
  assert.ok(out.includes('子任务 s2：**执行失败** —— 超时未返回'))
  assert.ok(!out.includes('后面还有一堆日志'))
})

test('★ buildPrompt：被跳过的上游 → 缺口说明里写明「被跳过」而不是「失败」', () => {
  /*
   * 「跳过」和「失败」对下游的含义不同：失败说明有人试过但没成，
   * 跳过说明引擎压根没让它跑。下游据此调整策略的方式也不一样，所以不能混成一句话。
   */
  const results = { s1: { status: 'skipped', skipKind: 'blocked', memberId: 'a', memberName: 'A', text: '未执行：依赖的 x 没有可用产出' } }
  const out = buildPrompt(st({ dependsOn: ['s1'] }), ctx(results), opts())
  assert.ok(out.includes('子任务 s1：**被跳过**'))
  assert.ok(!out.includes('**执行失败**'))
})

test('★ buildPrompt：上游没有 status 字段 → 也按缺口处理（不放过状态不明的上游）', () => {
  const results = { s1: { memberId: 'a', text: '不知道成败的产出' } }
  const out = buildPrompt(st({ dependsOn: ['s1'] }), ctx(results), opts())
  assert.ok(out.includes('【⚠️ 上游有缺口，你的结论必须带上这个前提】'))
  assert.ok(!out.includes('【上游产出，请基于它继续】'))
})

// ----------------------------------------------------------------- 截断

test('buildPrompt：★ 上游产出超长时截断，但头尾都保留（结论通常在末尾）', () => {
  /*
   * 这条断言是 2026-09-29 真跑之后改的。
   *
   * 原来是 `s.slice(0, n)` —— 只留开头。而当时上游 claude 交了一份 7392 字符的
   * 规则盘点报告，默认上限 4000，被切掉的 3392 字符里正好是**结论与结构性缺口清单**。
   * 下游会"看了半份报告还以为看完了"，比不传更危险。
   *
   * 断言用可区分的头尾（HEAD…TAIL），才能真正验出"两头都留" ——
   * 如果全用同一个字符，只留头的实现也能骗过断言。
   */
  const text = 'HEAD' + 'x'.repeat(500) + 'TAIL'
  const results = { s1: upRes({ memberId: 'claude', text }) }
  const out = buildPrompt(st({ dependsOn: ['s1'] }), ctx(results), opts({ upstreamExcerptChars: 200 }))
  assert.ok(out.includes('HEAD'), '开头要保留（参数、目录结构在这里）')
  assert.ok(out.includes('TAIL'), '★ 末尾必须保留（报错信息、报告结论在这里）')
  assert.ok(!out.includes('x'.repeat(500)), '中间确实被省略了')
  assert.match(out, /已按头尾保留截断/)
  assert.match(out, /原文 \d+ 字符/)
})

test('buildPrompt：上游产出恰好等于阈值时不截断', () => {
  const text = 'y'.repeat(10)
  const results = { s1: upRes({ memberId: 'claude', text }) }
  const out = buildPrompt(st({ dependsOn: ['s1'] }), ctx(results), opts({ upstreamExcerptChars: 10 }))
  assert.ok(out.includes(text))
  assert.ok(!out.includes('已按头尾保留截断'))
})

test('buildPrompt：上游 text 为空时输出空串，不报错', () => {
  const results = { s1: upRes({ memberId: 'claude', text: '' }) }
  const out = buildPrompt(st({ dependsOn: ['s1'] }), ctx(results), opts())
  assert.ok(out.includes('【上游产出，请基于它继续】'))
  assert.ok(!out.includes('已按头尾保留截断'))
})

// ------------------------------------------------------------- 多个上游顺序

test('buildPrompt：多个上游依赖按 dependsOn 顺序拼接', () => {
  const results = {
    s1: upRes({ memberId: 'a', memberName: 'A', role: '甲', text: '正文A' }),
    s2: upRes({ memberId: 'b', memberName: 'B', role: '乙', text: '正文B' }),
    s3: upRes({ memberId: 'c', memberName: 'C', role: '丙', text: '正文C' }),
  }
  const out = buildPrompt(st({ dependsOn: ['s2', 's1', 's3'] }), ctx(results), opts())
  const i2 = out.indexOf('来自子任务 s2')
  const i1 = out.indexOf('来自子任务 s1')
  const i3 = out.indexOf('来自子任务 s3')
  assert.ok(i2 < i1 && i1 < i3, '上游块应按 dependsOn 的顺序出现')
  // 块之间用空行连接
  assert.ok(out.includes('正文B\n\n—— 来自子任务 s1'))
})

test('buildPrompt：多个上游中部分缺失时，缺失的进缺口段、其余保持顺序', () => {
  const results = {
    s1: upRes({ memberId: 'a', memberName: 'A', text: '正文A' }),
    s2: upRes({ memberId: 'b', memberName: 'B', text: '正文B' }),
  }
  const out = buildPrompt(st({ dependsOn: ['s1', 'ghost', 's2'] }), ctx(results), opts())
  assert.ok(out.includes('来自子任务 s1'))
  assert.ok(out.includes('来自子任务 s2'))
  assert.ok(!out.includes('来自子任务 ghost'), '缺的那个不该混进上游正文段')
  assert.ok(out.includes('子任务 ghost：**没有产出**'), '★ 但要出现在缺口段里')
  assert.ok(out.indexOf('来自子任务 s1') < out.indexOf('来自子任务 s2'))
})

// ------------------------------------------------------------------ 结构

test('buildPrompt：段落顺序为 目标 → 子任务 → 角色 → 上游 → 要求', () => {
  const results = { s1: upRes({ memberId: 'a', text: '上' }) }
  const out = buildPrompt(st({ role: 'R', dependsOn: ['s1'] }), ctx(results), opts())
  const order = ['【任务总目标】', '【本次子任务】', '【你的角色】', '【上游产出，请基于它继续】', '【要求】']
  const idx = order.map((k) => out.indexOf(k))
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i - 1] >= 0 && idx[i - 1] < idx[i], `${order[i - 1]} 应排在 ${order[i]} 之前`)
  }
})

// --------------------------- 文件改动在传递链路上不被抹掉（回归，2026-09-29 补）
//
// 盯的是这一行：
//     changedFiles: r.changedFiles || []        ← 原来
//     changedFiles: r.changedFiles ?? null      ← 现在
//
// 适配器/采集器用 null 表示"没采集文件改动"，`|| []` 会把它兜成"采集了但没有改动"。
// 一旦兜掉，判定层的 `claimed-edit-no-change` 就会在**每一次写档运行**上误报 ——
// 因为那三条真实产出全写着"测试文件已写好/已写入"。
// 用桩适配器把整条链路走通，才钉得住这个区分：纯函数的单测看不到传递层。

/**
 * 造一个桩注册表。`run` 能拿到 opts（含 workdir），所以 `onRun` 可以**真的往磁盘写文件**，
 * 用来模拟"成员确实干活了"。只用到 registry.get → adapter.run 两个接口。
 */
/**
 * 桩成员的默认配置 —— **必须带上"档位真的能表达"的映射**。
 *
 * 从前这里压根没有 `spec`，而新判据 `memberMayWrite()` 恰恰要看成员是谁、
 * 档位能不能表达。没有 spec 时它只能当"未知"处理（按可能写），
 * 于是只读档也会被采集与定罪 —— 测出来的是一条现实中不存在的路径。
 *
 * 桩成员代表的是 claude / cursor / qoder 那类**四档齐全**的真实成员
 * （见 members.json），所以夹具就得长得像它们。
 */
const STUB_SPEC = {
  id: 'stub',
  name: '桩成员',
  capabilities: ['code', 'shell'],
  defaultPermission: 'plan',
  permissionArgs: {
    readonly: ['--ro'], plan: ['--plan'], execute: ['--write'], full: ['--yolo'],
  },
}

const stubRegistry = (result, onRun, spec = STUB_SPEC) => ({
  get: () => ({
    name: '桩成员',
    spec,
    run: async (opts) => {
      if (onRun) await onRun(opts)
      return { status: 'ok', text: '', changedFiles: null, cost: {}, raw: {}, ...result }
    },
  }),
})

/** 真实的成员配置 —— 有些行为取决于具体成员，夹具用假的话测不到真问题 */
const REAL_MEMBERS = JSON.parse(
  readFileSync(new URL('../src/config/members.json', import.meta.url), 'utf8')
).members
const realSpec = (id) => REAL_MEMBERS.find((m) => m.id === id)

/** 真实产出里的原话 —— 命中完成语，正是会触发误报的那种文本 */
const CLAIM_TEXT = '测试文件已写好：`tests/plan.test.mjs`（28 个用例）。'
const onePlan = (permission = 'execute') => ({
  goal: '写测试',
  subtasks: [{ id: 's1', memberId: 'stub', prompt: '写测试', permission }],
})

/** 每个用例给一个独立临时工作目录，避免误扫到本仓库（tools/ 有 8498 个文件） */
const madeDirs = []
const newWorkdir = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'agenthub-orch-')))
  madeDirs.push(d)
  return d
}
test.after(() => {
  for (const d of madeDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
  }
})

test('★ 未采集（trackChanges 关掉）时，链路不能把它兜成 []', async () => {
  const o = new Orchestrator(stubRegistry({ text: CLAIM_TEXT, changedFiles: null }), { trackChanges: false })
  const { ctx } = await o.run(onePlan(), { workdir: newWorkdir() })
  const e = ctx.results.s1
  assert.equal(e.changedFiles, null, '未采集必须保持 null，不许被 || [] 兜成空数组')
  assert.equal(e.quality.level, 'ok', '没采集数据时不能判"声称改了却没改"')
})

test('★ 适配器自己给了 []（确实采集到零改动）+ 写档 → 链路末端能判出来', async () => {
  const o = new Orchestrator(stubRegistry({ text: CLAIM_TEXT, changedFiles: [] }), { trackChanges: false })
  const { ctx } = await o.run(onePlan('execute'), { workdir: newWorkdir() })
  const e = ctx.results.s1
  assert.deepEqual(e.changedFiles, [])
  assert.equal(e.quality.level, 'suspect')
  assert.deepEqual(e.quality.codes, ['claimed-edit-no-change'])
})

test('权限档也要传到判定层：只读档下同样的数据不判', async () => {
  const o = new Orchestrator(stubRegistry({ text: CLAIM_TEXT, changedFiles: [] }), { trackChanges: false })
  const { ctx } = await o.run(onePlan('readonly'), { workdir: newWorkdir() })
  assert.equal(ctx.results.s1.quality.level, 'ok', '只读档零改动是正常的')
})

// ------------- 引擎自己采集（trackChanges 默认开）—— 规则由此从"死代码"变成"真的会触发"

test('★★ 成员真的写了文件 → 引擎采得出来，且不判可疑', async () => {
  const wd = newWorkdir()
  const o = new Orchestrator(
    stubRegistry({ text: CLAIM_TEXT }, async ({ workdir }) => {
      mkdirSync(join(workdir, 'tests'), { recursive: true })
      writeFileSync(join(workdir, 'tests/plan.test.mjs'), '// 28 个用例')
    })
  )
  const { ctx } = await o.run(onePlan('execute'), { workdir: wd })
  const e = ctx.results.s1
  assert.ok(Array.isArray(e.changedFiles), '写档下应当采集出数组')
  assert.deepEqual(e.changedFiles, ['tests/plan.test.mjs'])
  assert.equal(e.quality.level, 'ok', '确实改了就不该判可疑')
})

test('★★ 成员光说不动 → 采到 [] → claimed-edit-no-change 真的触发（规则活了）', async () => {
  /*
   * 这条是这一整轮的目的所在。
   * 在此之前，规则写好了、单测也绿，但 `changedFiles` 永远没人填 → 规则**永不触发**。
   * 现在引擎自己采集，这条路径才第一次被真正走通。
   */
  const o = new Orchestrator(stubRegistry({ text: CLAIM_TEXT }))
  const { ctx } = await o.run(onePlan('execute'), { workdir: newWorkdir() })
  const e = ctx.results.s1
  assert.deepEqual(e.changedFiles, [], '完整采集 + 零改动')
  assert.equal(e.quality.level, 'suspect', '声称写了却没写 → 必须判可疑')
  assert.deepEqual(e.quality.codes, ['claimed-edit-no-change'])
})

test('★ 采集不可信（工作目录不存在）→ 退成 null → 不判，绝不误报', async () => {
  const o = new Orchestrator(stubRegistry({ text: CLAIM_TEXT }))
  const ghost = join(tmpdir(), 'agenthub-不存在-' + Date.now())
  const { ctx } = await o.run(onePlan('execute'), { workdir: ghost })
  const e = ctx.results.s1
  assert.equal(e.changedFiles, null, '采不全必须退成 null，不能报成"零改动"')
  assert.equal(e.quality.level, 'ok', '宁可漏判，也不能拿没数据去定罪')
})

test('非写档 + 该档位真的能表达 → 不采集（省一趟快照，也确实是改不了文件的那一档）', async () => {
  const o = new Orchestrator(stubRegistry({ text: CLAIM_TEXT }))
  const { ctx } = await o.run(onePlan('plan'), { workdir: newWorkdir() })
  assert.equal(ctx.results.s1.changedFiles, null, 'plan 档不采集 → null')
})

/*
 * ═══ ★★ 权限档位到底有没有真的传下去 ═══
 *
 * 这组的两条盯的是同一个根因，方向相反。原先编排器一律用
 *     WRITE_PERMISSIONS.has(permission)
 * 来决定要不要采集文件改动，即**只信用户请求的那一档**。
 * 可"请求的档位"和"实际生效的档位"不是一回事（见 tests/permission.test.mjs）：
 * 前者会说谎，后者才是引擎该据以行事的东西。现在的判据是 `memberMayWrite()`。
 */

test('★★ trae 的只读档：档位塌缩 → 照样采集，声称改了而磁盘没动就照样定罪', async () => {
  /*
   * trae 的 `permissionArgs.readonly` 是 `[]`，和 plan 档一模一样 ——
   * 界面上写着「只读 —— 能读，不改文件、不跑命令」，却没有任何参数在约束它。
   * 老写法在这里**跳过采集**，于是成员真写了文件引擎也不知道，
   * 而判定层因为拿不到数据（null）永远不判 —— 静默失效，比误报更糟。
   */
  const o = new Orchestrator(stubRegistry({ text: CLAIM_TEXT }, null, realSpec('trae')))
  const { ctx } = await o.run(onePlan('readonly'), { workdir: newWorkdir() })
  const e = ctx.results.s1
  assert.ok(
    Array.isArray(e.changedFiles),
    '★ 档位无法表达时没有参数在约束成员 → 必须采集，不能因为"用户说是只读"就放弃核对'
  )
  assert.deepEqual(e.changedFiles, [], '成员确实一个文件都没动')
  assert.equal(e.quality.level, 'suspect', '声称写了而磁盘没变 → 该判就得判')
})

test('★★ 豆包这样的 REST 成员：选写档也不采集，更不许定罪（否则必然误报）', async () => {
  /*
   * 反方向的错。豆包是 REST 适配器，**没有文件系统能力**，永远不可能改文件。
   * 老写法在 execute 档下会照做目录快照，采集恒为空数组 ——
   * 而空数组在判定层的意思是"采集过、确实没改"，
   * 于是豆包产出里写一句"已创建文档"就被判可疑。**拿量不到东西的尺子定罪。**
   */
  const o = new Orchestrator(stubRegistry({ text: CLAIM_TEXT }, null, realSpec('doubao')))
  const { ctx } = await o.run(onePlan('execute'), { workdir: newWorkdir() })
  const e = ctx.results.s1
  assert.equal(e.changedFiles, null, '★ 没有写文件的能力 → 未采集（null），绝不能是 []')
  assert.equal(e.quality.level, 'ok', '★ 对没有写能力的成员，这条规则必须彻底安静')
})

// ═══════════════════════════════════════════════════════════════════════════
// 失败策略：一个子任务失败之后，剩下的活怎么办
//
// 起因（2026-09-29 真跑，docs/05 第九节）：4 个步骤，s1/s2 成功、s3 失败、
// s4 是最终交付。原来的布尔 `stopOnFailure: true` 一失败就把后面整单停掉，
// s4 永不执行 —— 已经花掉的 $0.2 只换到两份中间产物。**省钱的设计反而烧钱。**
//
// 下面这组测试用 5 个步骤复现那个形状，并且**同时**钉住三件事：
//   1. 三种策略各自跳过谁、放行谁；
//   2. 被跳过的和失败的要分开数、分开写；
//   3. ★ 任何子任务都不许**无声消失** —— 计划里有几条，轨迹里就必须有几条。
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 按成员区分成败的桩注册表。
 * `behave[memberId]` 为 `'ok'` / `'failed'`，用来精确复现"某一步挂了"。
 * 顺带记下**每个成员被调用了几次** —— 判断某个子任务到底跑没跑，看它最直接。
 */
const behaviorRegistry = (behave, calls = {}) => ({
  get: (id) => ({
    name: `桩-${id}`,
    run: async () => {
      calls[id] = (calls[id] || 0) + 1
      const how = typeof behave[id] === 'function' ? behave[id]() : (behave[id] || 'ok')
      return how === 'failed'
        ? { status: 'failed', text: `成员 ${id} 执行失败：模拟的失败原因`, cost: {}, raw: { exitCode: 1 }, changedFiles: null }
        : { status: 'ok', text: `成员 ${id} 的产出`, cost: {}, raw: { exitCode: 0 }, changedFiles: null }
    },
  }),
})

/**
 * 复现实跑那次的形状：
 *   第 1 层 s1 / s2 / s3（互不依赖，并行）
 *   第 2 层 s4 依赖 s1+s2+s3 —— **最终交付**
 *   第 2 层 s5 只依赖 s1 —— **不依赖失败结果的那条分支**
 * `s3` 让它失败。
 */
const failPlan = () => ({
  goal: '复现实跑：第三步挂了，最终交付还要不要跑',
  subtasks: [
    { id: 's1', memberId: 'a', prompt: '第一步' },
    { id: 's2', memberId: 'a', prompt: '第二步' },
    { id: 's3', memberId: 'b', prompt: '第三步（这一步会挂）' },
    { id: 's4', memberId: 'c', prompt: '汇总前面所有产出，交出最终报告', dependsOn: ['s1', 's2', 's3'] },
    { id: 's5', memberId: 'd', prompt: '基于第一步的另一条支线', dependsOn: ['s1'] },
  ],
})

const runPolicy = async (policy, options = {}) => {
  const calls = {}
  const o = new Orchestrator(behaviorRegistry({ a: 'ok', b: 'failed', c: 'ok', d: 'ok' }, calls), {
    permission: 'plan', ...options, ...(policy ? { onFailure: policy } : {}),
  })
  const { trace, ctx } = await o.run(failPlan(), { workdir: newWorkdir() })
  return { trace, ctx, calls, md: trace.toMarkdown(), s: trace.summary }
}

// ── 策略名的解析与向后兼容 ──────────────────────────────────────────────

test('resolveFailurePolicy：默认是 skip-blocked（不整单停，也不带洞硬跑）', () => {
  assert.equal(resolveFailurePolicy(), 'skip-blocked')
  assert.equal(resolveFailurePolicy({}), 'skip-blocked')
  assert.equal(resolveFailurePolicy({ permission: 'plan' }), 'skip-blocked')
})

test('resolveFailurePolicy：显式策略原样采纳', () => {
  for (const p of FAILURE_POLICIES) assert.equal(resolveFailurePolicy({ onFailure: p }), p)
})

test('★ resolveFailurePolicy：兼容旧的布尔 stopOnFailure', () => {
  // 旧语义 true = 失败即停 → abort
  assert.equal(resolveFailurePolicy({ stopOnFailure: true }), 'abort')
  // 旧语义 false = 谁都不停 → salvage。
  // 注意旧代码在 false 时是"**带洞静默继续**"（依赖缺失时上游整块被跳过、下游不知情），
  // 映射到 salvage 后缺口会被明说 —— 这是这条兼容规则里唯一的行为变化，且是往好里变。
  assert.equal(resolveFailurePolicy({ stopOnFailure: false }), 'salvage')
})

test('★ resolveFailurePolicy：显式 onFailure 优先于旧布尔，写错就报错（不静默兜底）', () => {
  assert.equal(resolveFailurePolicy({ onFailure: 'abort', stopOnFailure: false }), 'abort')
  assert.throws(() => resolveFailurePolicy({ onFailure: 'typo' }), /未知的失败策略/)
})

test('brokenDeps：结果缺失 / 失败 / 被跳过 都算断链，ok 不算', () => {
  const ctx2 = { results: { s1: { status: 'ok' }, s2: { status: 'failed' }, s3: { status: 'skipped' } } }
  assert.deepEqual(brokenDeps({ dependsOn: ['s1'] }, ctx2), [])
  assert.deepEqual(brokenDeps({ dependsOn: ['s1', 's2', 's3', 'ghost'] }, ctx2), [
    { id: 's2', how: 'failed' },
    { id: 's3', how: 'skipped' },
    { id: 'ghost', how: 'missing' },
  ])
  assert.deepEqual(brokenDeps({}, ctx2), [], '没有依赖就没有断链')
})

// ── abort：老的"失败即停" ───────────────────────────────────────────────

test('★ abort：失败后整单停止 —— 但被停掉的每一步都必须在轨迹里有一格', async () => {
  const { ctx, s, calls, md } = await runPolicy('abort')

  // 老行为：停下来
  assert.equal(ctx.aborted, true)
  assert.equal(calls.c, undefined, 'abort 策略下最终交付不该被调用')
  assert.equal(calls.d, undefined, '不依赖失败结果的分支也被一起停掉了（这正是 abort 的代价）')

  // ★ 新行为：不许无声消失。计划 5 条，轨迹必须 5 条
  assert.equal(s.subtaskCount, 5)
  assert.equal(ctx.results.s4.status, 'skipped')
  assert.equal(ctx.results.s4.skipKind, 'aborted')
  assert.equal(ctx.results.s5.status, 'skipped')
  assert.match(ctx.results.s4.text, /中止整单/)

  // ★ 「失败」和「没执行」必须分开数 —— 混在一起报告就会说"3 个失败"，而实际只挂了 1 个
  assert.equal(s.failedCount, 1, '只有 s3 是真失败')
  assert.equal(s.skippedCount, 2, 's4 / s5 是没执行')
  assert.equal(s.skippedByKind.aborted, 2)
  assert.match(md, /1 失败\s+·\s+2 未执行/)
  assert.match(md, /- 状态：\*\*未执行\*\*/)
})

// ── skip-blocked：默认。只跳过真正被断链的 ──────────────────────────────

test('★★ skip-blocked（默认）：只跳过依赖断了的，不依赖失败结果的分支照跑完', async () => {
  const { ctx, s, calls, md } = await runPolicy(null)   // 不传策略 → 走默认

  // s3 依赖断链 → s4 跳过
  assert.equal(ctx.results.s4.status, 'skipped')
  assert.equal(ctx.results.s4.skipKind, 'blocked')
  assert.match(ctx.results.s4.text, /依赖的 s3 没有可用产出/)
  // ★ s5 只依赖 s1（成功），它的前提没被破坏 → 必须照跑
  assert.equal(calls.d, 1, '不依赖失败结果的分支要跑完，否则它的条件就被白白作废了')
  assert.equal(ctx.results.s5.status, 'ok')

  assert.equal(s.okCount, 3, 's1 / s2 / s5')
  assert.equal(s.failedCount, 1)
  assert.equal(s.skippedCount, 1)
  assert.equal(s.subtaskCount, 5, '★ 5 条计划 5 条轨迹，一条都不许消失')

  // 报告里要说清"跳过"和"失败"的分别
  assert.match(md, /3 \/ 5 成功/)
  assert.match(md, /1 未执行（引擎未调用成员：1 条依赖断链）/)
  assert.match(md, /\[\*\]|未执行/)
  // 没执行的条目花费是**已知的零**，不该印成"未知"
  assert.match(md, /\| 4 \| s4 .*\| 未执行 \| 0ms \| — \|/)
})

// ── salvage：带洞也要那份最终交付 ───────────────────────────────────────

test('★★ salvage：最终交付照样跑，但"缺了谁"必须同时写进 prompt 和报告', async () => {
  const { ctx, s, calls, md } = await runPolicy('salvage')

  // 最关键的一条：这次最终交付**真的产出了**
  assert.equal(calls.c, 1, 'salvage 下最终交付必须被执行 —— 这正是这个策略存在的理由')
  assert.equal(ctx.results.s4.status, 'ok')
  // 但它是在有缺口的情况下跑的，这件事必须留在数据里
  assert.deepEqual(ctx.results.s4.degradedUpstream, ['s3'])
  assert.deepEqual(ctx.results.s5.degradedUpstream, [], '上游齐备的那条不该被标缺口')
  assert.equal(s.degradedCount, 1)

  // ★ 缺口必须进了给下游的 prompt —— 否则下游会以为"我依赖的东西本来就不存在"
  assert.match(ctx.results.s4.prompt, /【⚠️ 上游有缺口，你的结论必须带上这个前提】/)
  assert.match(ctx.results.s4.prompt, /子任务 s3：\*\*执行失败\*\* —— 成员 b 执行失败/)
  assert.match(ctx.results.s4.prompt, /不要假装它们的结果存在/)

  // ★ 报告里也必须标出来，别把"半份成果"当"完整成果"递出去
  assert.match(md, /其中 1 个是在上游有缺口的情况下跑的/)
  assert.match(md, /- ⚠️ \*\*上游缺口\*\*：本任务是在 s3 没有可用产出的情况下执行的/)
  assert.match(md, /\| 4 \| s4 .*\| ok ⚠️缺口 \|/)

  assert.equal(s.failedCount, 1)
  assert.equal(s.skippedCount, 0, 'salvage 下不跳过任何一步')
})

// ── 三种策略的横向对照：同一份计划、同一个失败，三条不同的路 ────────────

test('★★ 三种策略横向对照：跳过谁 / 放行谁 / 最终交付有没有拿到', async () => {
  const abort = await runPolicy('abort')
  const skip = await runPolicy('skip-blocked')
  const salv = await runPolicy('salvage')

  const got = (r) => r.ctx.results.s4.status
  const branch = (r) => r.ctx.results.s5.status

  // 最终交付（s4，依赖挂在 s3 上）
  assert.equal(got(abort), 'skipped')
  assert.equal(got(skip), 'skipped')
  assert.equal(got(salv), 'ok', '只 salvage 能拿到那份最终交付')

  // 独立分支（s5，只依赖成功的 s1）
  assert.equal(branch(abort), 'skipped', 'abort 会连不相关的分支一起停')
  assert.equal(branch(skip), 'ok')
  assert.equal(branch(salv), 'ok')

  // ★ 三种策略下，轨迹条数都必须等于计划条数 —— 这是"不许无声消失"的横切保证
  for (const [name, r] of [['abort', abort], ['skip-blocked', skip], ['salvage', salv]]) {
    assert.equal(r.s.subtaskCount, 5, `${name}：计划 5 条，轨迹 ${r.s.subtaskCount} 条`)
    assert.equal(r.trace.entries.length, 5)
  }
})

// ── 预算闸也算"没执行"，不是"失败" ──────────────────────────────────────

test('★ 预算闸拦下的步骤记成「未执行（预算上限）」，不是「失败」', async () => {
  const { s, ctx, calls, md } = await runPolicy(null, { totalBudgetUsd: 0 })

  assert.equal(Object.keys(calls).length, 0, '预算为 0 时一个成员都不该被调用')
  assert.equal(s.okCount, 0)
  assert.equal(s.failedCount, 0, '★ 没有任何成员失败 —— 说"失败"就是假的')
  assert.equal(s.skippedCount, 5)
  assert.equal(s.subtaskCount, 5, '★ 仍然一条不许消失')

  /*
   * 分类按**直接原因**，不是追根因：
   *   第 1 层的 s1/s2/s3 直接撞上预算闸 → budget
   *   第 2 层的 s4/s5 是因为它们依赖的 s1 被跳过了 → blocked
   * 这是有意的 —— 每条记录说"我为什么没跑"，逐条查上去就能追到根因，
   * 而把它们全标成 budget 反而会让"这条到底卡在哪"变得不可查。
   */
  assert.equal(s.skippedByKind.budget, 3, '第 1 层直接撞预算')
  assert.equal(s.skippedByKind.blocked, 2, '第 2 层是依赖被跳过')
  assert.match(ctx.results.s1.text, /已触及总预算上限/)
  assert.match(ctx.results.s4.text, /依赖的 s1、s2、s3 没有可用产出/)
  // 顺着 s4 记的原因查回 s1，就能看到根因是预算 —— 链条是可追的
  assert.match(ctx.results.s1.text, /总预算上限/)

  // 报告里的措辞也要对得上
  assert.match(md, /5 未执行（引擎未调用成员：2 条依赖断链、3 条预算上限）/)
  assert.match(md, /0 失败/)
})


// ═══════════════════════════════════════════════════════════════════════════
// 单卡片重试 / 换人 / 跳过
//
// 要解决的问题：一次真跑里某一步挂了，原来只能**整单重跑** —— 已经成功的那几步
// 会再花一遍钱。而"重试"这个功能存在的全部理由，就是别重复花已经花过的钱。
//
// 所以这一组测试盯的头号目标是**花钱的边界**，不是"能跑起来"：
//   ① 已 ok 的步骤，重试时一次都不许再调；
//   ② 已 failed 的步骤，只有用户点名的那一个才重跑；
//   ③ 轨迹条数不能因为重跑而变多（同一个子任务两条记录 = 数字全乱）。
// ═══════════════════════════════════════════════════════════════════════════

const retryPlan = () => ({
  goal: 'g',
  subtasks: [
    { id: 's1', memberId: 'a', prompt: 'p1' },
    { id: 's2', memberId: 'b', prompt: 'p2' },
    { id: 's3', memberId: 'c', prompt: 'p3', dependsOn: ['s1', 's2'] },
    { id: 's4', memberId: 'd', prompt: 'p4', dependsOn: ['s1'] },
  ],
})

// ── needsRun：花钱的边界 ──────────────────────────────────────────────

test('★★ needsRun：已成功的绝不重跑，已失败的只重跑点名的那个，被跳过的才重新评估', () => {
  const o = new Orchestrator(behaviorRegistry({}), { permission: 'plan' })
  const c = {
    results: {
      ok1: { status: 'ok' },
      bad1: { status: 'failed' },
      skip1: { status: 'skipped', skipKind: 'blocked' },
      user1: { status: 'skipped', skipKind: 'user' },
    },
  }
  // 首跑：什么都得跑
  assert.equal(o.needsRun({ id: 'ok1' }, c, 'initial', null), true)

  // 续跑
  assert.equal(o.needsRun({ id: 'ok1' }, c, 'resume', null), false, '★ 已成功的绝不重跑')
  assert.equal(o.needsRun({ id: 'ok1' }, c, 'resume', 'ok1'), false, '★ 就算点名也不重跑已成功的')
  assert.equal(o.needsRun({ id: 'bad1' }, c, 'resume', null), false, '★ 失败的活不能"顺便"重跑 —— 那是新的开销')
  assert.equal(o.needsRun({ id: 'bad1' }, c, 'resume', 'bad1'), true, '点名了才重跑')
  assert.equal(o.needsRun({ id: 'skip1' }, c, 'resume', null), true, '被策略跳过的重新评估（免费）')
  assert.equal(o.needsRun({ id: 'user1' }, c, 'resume', 'user1'), false, '★ 用户拍板放弃的，不许翻案重跑')
  assert.equal(o.needsRun({ id: 'never' }, c, 'resume', null), true, '还没跑过的当然要跑')
})

// ── 重试 ─────────────────────────────────────────────────────────────

test('★★ 重试：补上那一步之后，被卡住的下游自己跑起来；已成功的步骤一次都没再调', async () => {
  const calls = {}
  let n = 0
  const o = new Orchestrator(
    behaviorRegistry({ a: 'ok', b: () => (++n === 1 ? 'failed' : 'ok'), c: 'ok', d: 'ok' }, calls),
    { permission: 'plan' }
  )
  const plan = retryPlan()
  const { ctx, trace } = await o.run(plan, { workdir: newWorkdir() })
  assert.equal(ctx.results.s2.status, 'failed')
  assert.equal(ctx.results.s3.status, 'skipped', 's3 依赖 s2，被卡住')
  assert.equal(calls.c, undefined, 's3 压根没被调用过')

  await o.resume(plan, { ctx, trace, onEvent: () => {}, onlyId: 's2' })

  assert.equal(ctx.results.s2.status, 'ok', '第二步这次成了')
  assert.equal(ctx.results.s3.status, 'ok', '★ 下游自己跑起来了 —— 这正是不用整单重跑省下的钱')
  assert.equal(calls.a, 1, '★ s1 已成功，不许重跑')
  assert.equal(calls.d, 1, '★ s4 已成功，不许重跑')
  assert.equal(calls.b, 2, '只重跑了点名的 s2')
  assert.equal(calls.c, 1, 's3 这是第一次跑')
  assert.equal(trace.entries.length, 4, '★ 轨迹条数 = 计划条数，重跑不许让记录变多')
  assert.equal(trace.summary.subtaskCount, 4)
  assert.equal(trace.summary.okCount, 4)
  assert.equal(trace.summary.failedCount, 0)
})

test('★★ 反复重试仍然失败 → 轨迹里不许出现同一个子任务两条记录', async () => {
  /*
   * 这条盯的是 `trace.upsert`。用 `add` 的话，每重跑一次就多一条，
   * 报告里同一个子任务会先出现一条 failed 再出现一条新的 ——
   * 而"轨迹条数 === 计划条数"是上一轮拿来当"不许无声消失"的横切保证，破了它两边都不可信。
   */
  const calls = {}
  const o = new Orchestrator(behaviorRegistry({ a: 'ok', b: 'failed', c: 'ok', d: 'ok' }, calls), { permission: 'plan' })
  const plan = retryPlan()
  const { ctx, trace } = await o.run(plan, { workdir: newWorkdir() })
  await o.resume(plan, { ctx, trace, onEvent: () => {}, onlyId: 's2' })
  await o.resume(plan, { ctx, trace, onEvent: () => {}, onlyId: 's2' })

  assert.equal(trace.entries.length, 4, `重试两次后仍应是 4 条，实际 ${trace.entries.length}`)
  assert.equal(trace.entries.filter((e) => e.id === 's2').length, 1, 's2 只能有一条')
  assert.deepEqual(trace.entries.map((e) => e.id), ['s1', 's2', 's3', 's4'], '顺序也不该乱')
  assert.equal(calls.b, 3, '首跑 + 两次重试')
  assert.equal(ctx.results.s2.status, 'failed')
  assert.equal(ctx.results.s3.status, 'skipped', 's2 还是失败，s3 继续被卡住')
})

test('★ 换人：改的是计划本身 —— 计划、结果、轨迹里都得是新成员（否则报告张冠李戴）', async () => {
  const calls = {}
  const o = new Orchestrator(behaviorRegistry({ a: 'ok', b: 'failed', c: 'ok', d: 'ok', x: 'ok' }, calls), { permission: 'plan' })
  const plan = retryPlan()
  const { ctx, trace } = await o.run(plan, { workdir: newWorkdir() })

  await o.retrySubtask(plan, { ctx, trace, onEvent: () => {}, id: 's2', memberId: 'x' })

  assert.equal(plan.subtasks[1].memberId, 'x', '计划里要真的改掉')
  assert.equal(ctx.results.s2.memberId, 'x')
  assert.equal(trace.entries.find((e) => e.id === 's2').memberId, 'x')
  assert.equal(calls.x, 1)
  assert.equal(calls.b, 1, '旧成员只被调用过一次')
  assert.equal(ctx.results.s3.status, 'ok', '换了人之后下游也该跑起来')
  // 报告里显示的成员名要跟着变
  assert.match(trace.toMarkdown(), /\| 2 \| s2 .*\| 桩-x \|/)
})

test('重试不存在的子任务 → 当场报错（不静默什么都不做）', async () => {
  const o = new Orchestrator(behaviorRegistry({ a: 'ok' }), { permission: 'plan' })
  const plan = retryPlan()
  const { ctx, trace } = await o.run(plan, { workdir: newWorkdir() })
  await assert.rejects(() => o.retrySubtask(plan, { ctx, trace, onEvent: () => {}, id: 'ghost' }), /没有子任务 ghost/)
})

// ── 跳过 ─────────────────────────────────────────────────────────────

test('★★ 用户跳过：下游带着缺口继续跑，且这一步再也不被重跑', async () => {
  const calls = {}
  const o = new Orchestrator(behaviorRegistry({ a: 'ok', b: 'failed', c: 'ok', d: 'ok' }, calls), { permission: 'plan' })
  const plan = retryPlan()
  const { ctx, trace } = await o.run(plan, { workdir: newWorkdir() })
  assert.equal(ctx.results.s3.status, 'skipped')

  await o.skipSubtask(plan, { ctx, trace, onEvent: () => {}, id: 's2' })

  assert.equal(ctx.results.s2.status, 'skipped')
  assert.equal(ctx.results.s2.skipKind, 'user', '★ 必须记成"用户跳过"，不能混成"被策略跳过"')
  assert.match(ctx.results.s2.text, /已由用户跳过/)
  assert.equal(ctx.results.s3.status, 'ok', '★ 用户拍板不要 s2 了，它就不该再卡住 s3')
  assert.deepEqual(ctx.results.s3.degradedUpstream, ['s2'], 's3 是在有缺口的情况下跑的，要标出来')
  assert.equal(calls.b, 1, '跳过不会去跑它')

  // 再续跑一次：被用户跳过的步骤不许被拉起来
  await o.resume(plan, { ctx, trace, onEvent: () => {} })
  assert.equal(calls.b, 1, '★ 用户跳过是最终决定，续跑不许翻案')
  assert.equal(trace.entries.length, 4)
  assert.equal(trace.summary.skippedCount, 1)
  assert.equal(trace.summary.skippedByKind.blocked, 0)

  // 报告里要区分"用户跳过"和"被策略跳过"
  const md = trace.toMarkdown()
  assert.match(md, /已由用户跳过/)
  assert.match(md, /上游缺口/)
})

test('★ 给下游的指令里，"用户主动跳过"和"执行失败"措辞不同', () => {
  const userSkip = { status: 'skipped', skipKind: 'user', memberId: 'a', memberName: 'A', text: '已由用户跳过：不要了' }
  const out = buildPrompt(st({ dependsOn: ['s2'] }), ctx({ s2: userSkip }), opts())
  assert.match(out, /子任务 s2：\*\*被用户主动跳过（确认不要这一步的产出）\*\*/)
  assert.doesNotMatch(out, /执行失败/)
})

test('跳过不存在的子任务 → 当场报错', async () => {
  const o = new Orchestrator(behaviorRegistry({ a: 'ok' }), { permission: 'plan' })
  const plan = retryPlan()
  const { ctx, trace } = await o.run(plan, { workdir: newWorkdir() })
  await assert.rejects(() => o.skipSubtask(plan, { ctx, trace, onEvent: () => {}, id: 'ghost' }), /没有子任务 ghost/)
})

// ── 现场丢了怎么办 ───────────────────────────────────────────────────

test('★★ 续跑必须有现场：拿不到现场就报错，绝不退化成"整单重跑"', async () => {
  /*
   * 这条是安全阀。续跑如果"找不到现场就从头跑一遍"，
   * 那就是在用户没同意的情况下把已经花过的钱再花一遍 —— 比不给重试功能更糟。
   */
  const o = new Orchestrator(behaviorRegistry({ a: 'ok' }), { permission: 'plan' })
  await assert.rejects(() => o.resume(retryPlan(), { onEvent: () => {} }), /需要同一次运行的现场/)
  await assert.rejects(() => o.resume(retryPlan(), { ctx: {}, onEvent: () => {} }), /需要同一次运行的现场/)
})

test('★ 续跑要清掉上一次的中止状态 —— 用户既然要求接着跑，就不该还被"整单中止"压着', async () => {
  const calls = {}
  const o = new Orchestrator(behaviorRegistry({ a: 'ok', b: 'failed', c: 'ok', d: 'ok' }, calls), { permission: 'plan', onFailure: 'abort' })
  const plan = retryPlan()
  const { ctx, trace } = await o.run(plan, { workdir: newWorkdir() })
  assert.equal(ctx.aborted, true)
  await o.resume(plan, { ctx, trace, onEvent: () => {} })
  assert.equal(ctx.aborted, false, '续跑时中止标记要清掉')
  assert.equal(ctx.abortReason, '')
})

// ═══════════════════════════════════════════════════════════════════════════
// 收尾：整单首跑也必须 finish + 发 plan-finish（2026-09-29 回归）
//
// 抽 `advance()` 时，`run()` 结尾的这两行被一起搬进了 `resume()`，
// 于是整单跑完之后 `finishedAt` 恒为 null、`durationMs` 恒为 0（报告印「总耗时 0.0s」），
// 而且 `plan-finish` 永不发出 —— 命令行的完成汇总行、界面的"全部结束：…"都不触发。
// 两件事都**没有任何断言覆盖**，所以安静地退化了两轮。
// ═══════════════════════════════════════════════════════════════════════════

test('★★ run()：整单跑完必须收尾 —— finishedAt 要有值，durationMs 不许停在初始值 0', async () => {
  const o = new Orchestrator(behaviorRegistry({ a: 'ok' }), { permission: 'plan' })
  const { trace } = await o.run({ goal: '收尾检查', subtasks: [{ id: 's1', memberId: 'a', prompt: 'x' }] },
    { workdir: newWorkdir() })

  assert.ok(trace.finishedAt instanceof Date, 'finishedAt 必须写入 —— 否则报告印「总耗时 0.0s」是假数字')
  assert.equal(trace.summary.finishedAt, trace.finishedAt.toISOString())
  /*
   * 这里**不能断言 `durationMs > 0`**：桩成员在同一毫秒内就结束了，0 是它的真实值。
   * `durationMs === 0` 本身就是个歧义值 ——「没测到」和「确实不到 1 毫秒」都可能是 0。
   * 区分这两者的**唯一判据是 `finishedAt`**（上面已断言），
   * 而"耗时是算出来的、不是停在初始值"这件事要用结构来证：
   */
  assert.equal(trace.summary.durationMs, trace.finishedAt - trace.startedAt,
    '耗时必须在 finish() 时真的算出来；没算过的话这里会是 NaN 或停在 0')
  assert.match(trace.toMarkdown(), /总耗时 \d+\.\ds/, '报告里的总耗时必须是测到的秒数')
})

test('★★ run()：整单首跑必须发 plan-finish —— 命令行的完成汇总行全靠它', async () => {
  const events = []
  const o = new Orchestrator(behaviorRegistry({ a: 'ok' }), { permission: 'plan' })
  await o.run({ goal: '事件检查', subtasks: [{ id: 's1', memberId: 'a', prompt: 'x' }] },
    { workdir: newWorkdir(), onEvent: (e) => events.push(e) })

  const types = events.map((e) => e.type)
  assert.ok(types.includes('plan-finish'), `run() 必须发 plan-finish，实际只发了：${types.join(', ')}`)

  const fin = events.find((e) => e.type === 'plan-finish')
  assert.equal(fin.reason, 'initial')
  assert.ok(fin.summary && typeof fin.summary.okCount === 'number', 'plan-finish 必须带上完整的 summary')
  assert.equal(fin.summary.finishedAt !== null, true, 'summary 里也得是收尾后的样子')
})
