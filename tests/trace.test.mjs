/**
 * Trace 单元测试 —— 序号累加 / summary 统计 / toJSON 结构 / toMarkdown 渲染
 * 运行：node --test tests/trace.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { Trace, costOf, costCell, costTotalCell, skipCell, durationCell } from '../src/engine/trace.js'
import { judgeOutput } from '../src/engine/quality.js'

/** 造一条默认成功的 entry，可按需覆盖字段 */
const entry = (over = {}) => ({
  id: 'st-1',
  title: '写测试',
  memberId: 'm1',
  memberName: '测试员',
  role: '测试',
  status: 'ok',
  durationMs: 100,
  prompt: '请写测试',
  text: '写完了',
  raw: { command: 'node x.js', exitCode: 0, stderr: '' },
  cost: { usd: 0.01, inputTokens: 100, outputTokens: 50 },
  ...over,
})

/**
 * 造一条「未执行」的 entry —— 引擎没调用成员的那一种。
 * `status: 'skipped'` 是第三种状态：既不是成功，也不是失败。
 */
const skipEntry = (over = {}) => ({
  id: 'st-skip',
  title: '没跑的活',
  memberId: 'm1',
  memberName: '桩成员',
  role: '执行者',
  status: 'skipped',
  skipKind: 'blocked',
  durationMs: 0,
  prompt: '这一步没跑',
  text: '未执行：依赖的 x 没有可用产出',
  raw: {},
  cost: {},
  ...over,
})

test('add：序号从 1 开始逐条累加，并返回写入的行', () => {
  const t = new Trace('目标')
  const a = t.add(entry({ id: 'st-1' }))
  const b = t.add(entry({ id: 'st-2' }))
  const c = t.add(entry({ id: 'st-3' }))

  assert.equal(a.index, 1)
  assert.equal(b.index, 2)
  assert.equal(c.index, 3)
  assert.deepEqual(
    t.entries.map((e) => e.index),
    [1, 2, 3]
  )
  assert.equal(t.entries.length, 3)
  // 返回值就是存入的那一行（同一个引用）
  assert.equal(t.entries[1], b)
  assert.equal(b.id, 'st-2')
})

test('add：entry 自带的 index 会覆盖自动序号（保持原字段不被改写）', () => {
  const t = new Trace('目标')
  t.add(entry({ index: 99 }))
  assert.equal(t.entries[0].index, 99)
  // 后续自动序号仍按数组长度推进
  const second = t.add(entry())
  assert.equal(second.index, 2)
})

test('add：不修改传入的原始对象（写入的是浅拷贝）', () => {
  const t = new Trace('目标')
  const src = entry({ id: 'st-1' })
  t.add(src)
  assert.equal(Object.hasOwn(src, 'index'), false)
})

test('summary：空轨迹的计数、成本与 finishedAt', () => {
  const t = new Trace('空目标')
  const s = t.summary

  assert.equal(s.goal, '空目标')
  assert.equal(s.subtaskCount, 0)
  assert.equal(s.okCount, 0)
  assert.equal(s.failedCount, 0)
  assert.equal(s.totalCostUsd, 0)
  assert.equal(s.totalInputTokens, 0)
  assert.equal(s.totalOutputTokens, 0)
  assert.equal(s.durationMs, 0)
  assert.equal(s.finishedAt, null)
  assert.equal(s.startedAt, t.startedAt.toISOString())
})

test('summary：成功/失败计数 —— 只有 status === "ok" 才算成功', () => {
  const t = new Trace('目标')
  t.add(entry({ status: 'ok' }))
  t.add(entry({ status: 'failed' }))
  t.add(entry({ status: 'timeout' }))
  t.add(entry({ status: 'ok' }))

  const s = t.summary
  assert.equal(s.subtaskCount, 4)
  assert.equal(s.okCount, 2)
  assert.equal(s.failedCount, 2)
})

test('summary：成本与 token 累加，同时把"没上报的条数"记下来', () => {
  const t = new Trace('目标')
  t.add(entry({ cost: { usd: 0.1, inputTokens: 1000, outputTokens: 200 } }))
  t.add(entry({ cost: { usd: 0.2, inputTokens: 500, outputTokens: 300 } }))
  t.add(entry({ cost: undefined })) // 完全没有 cost
  t.add(entry({ cost: { usd: 0.05 } })) // 只有 usd

  const s = t.summary
  // 总额本身仍是"已知部分之和" —— 这一层不猜
  assert.equal(s.totalCostUsd, 0.35)
  assert.equal(s.totalInputTokens, 1500)
  assert.equal(s.totalOutputTokens, 500)
  /*
   * ★ 但必须同时记下"有 1 条没报" —— 否则 `$0.35` 会被读成"总共就花了 0.35"。
   * 这一条是 2026-09-29 补的：qoder 按积分计费、CLI 不返回美元成本，
   * 而报告里它显示成一个确定的 $0.0000。
   */
  assert.equal(s.costUnknownCount, 1)
  assert.equal(s.tokenReportedCount, 2, '4 条里只有 2 条同时带了 token（另两条一个没 cost、一个只有 usd）')
})

test('summary：积分单独记，不折算成美元', () => {
  const t = new Trace('目标')
  t.add(entry({ cost: { credits: 0.157647882 } })) // qoder 实测形态
  t.add(entry({ cost: { usd: 0.2, inputTokens: 10 } }))

  const s = t.summary
  assert.equal(s.totalCostUsd, 0.2, '积分不算进美元总额 —— 汇率和单价都不该由我们编')
  assert.equal(s.costUnknownCount, 1, '积分计费的那条也是"没报美元成本"')
  assert.equal(s.creditsReportedCount, 1)
  assert.equal(s.totalCredits, 0.157648, '积分四舍五入到 6 位')
})

test('summary：成本四舍五入到 4 位小数（浮点误差被吃掉）', () => {
  const t = new Trace('目标')
  t.add(entry({ cost: { usd: 0.1 } }))
  t.add(entry({ cost: { usd: 0.2 } }))

  const s = t.summary
  assert.equal(s.totalCostUsd, 0.3) // 而非 0.30000000000000004
  assert.equal(s.totalCostUsd, Number((0.1 + 0.2).toFixed(4)))
})

test('summary：极小成本会被 toFixed(4) 归零', () => {
  const t = new Trace('目标')
  t.add(entry({ cost: { usd: 0.00001 } }))
  assert.equal(t.summary.totalCostUsd, 0)
})

test('finish：写入 finishedAt 并记录耗时，summary 随之变化', () => {
  const t = new Trace('目标')
  assert.equal(t.finishedAt, null)
  assert.equal(t.summary.finishedAt, null)

  t.finish()

  assert.ok(t.finishedAt instanceof Date)
  assert.ok(t.durationMs >= 0)
  assert.equal(t.durationMs, t.finishedAt - t.startedAt)
  assert.equal(t.summary.durationMs, t.durationMs)
  assert.equal(t.summary.finishedAt, t.finishedAt.toISOString())
})

test('toJSON：结构为 summary 字段平铺 + entries 数组', () => {
  const t = new Trace('目标')
  t.add(entry({ id: 'st-1', status: 'ok' }))
  t.add(entry({ id: 'st-2', status: 'failed' }))
  t.finish()

  const json = t.toJSON()

  assert.deepEqual(Object.keys(json).sort(), [
    'costUnknownCount',
    'creditsReportedCount',
    'degradedCount',
    'durationMs',
    'entries',
    'executedCount',
    'failedCount',
    'finishedAt',
    'goal',
    'okCount',
    'skippedByKind',
    'skippedCount',
    'startedAt',
    'subtaskCount',
    'suspectCount',
    'tokenReportedCount',
    'totalCostUsd',
    'totalCredits',
    'totalInputTokens',
    'totalOutputTokens',
  ])
  assert.equal(json.goal, '目标')
  assert.equal(json.subtaskCount, 2)
  assert.equal(json.okCount, 1)
  assert.equal(json.failedCount, 1)
  assert.equal(json.suspectCount, 0)
  // 这两条都没有 skipped，所以 executedCount 与 subtaskCount 相等
  assert.equal(json.executedCount, 2)
  assert.equal(json.skippedCount, 0)
  assert.deepEqual(json.skippedByKind, { blocked: 0, aborted: 0, budget: 0, user: 0 })
  assert.equal(json.degradedCount, 0)
  assert.ok(Array.isArray(json.entries))
  assert.equal(json.entries.length, 2)
  assert.equal(json.entries[0].index, 1)
  assert.equal(json.entries[1].id, 'st-2')
  // 顶层统计与 summary 一致
  const { entries, ...rest } = json
  assert.deepEqual(rest, t.summary)
  // 可被 JSON.stringify 序列化
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(json)))
})

test('toMarkdown：空轨迹也能生成，含标题与表头', () => {
  const t = new Trace('空目标')
  const md = t.toMarkdown()

  assert.equal(typeof md, 'string')
  assert.match(md, /# 运行轨迹报告/)
  assert.match(md, /\*\*目标\*\*：空目标/)
  assert.match(md, /\| # \| 子任务 \| 成员 \| 角色 \| 状态 \| 耗时 \| 花费 \|/)
  assert.match(md, /0 \/ 0 成功/)
})

test('toMarkdown：包含关键小节（结果/Token/汇总表格/逐条详情）', () => {
  const t = new Trace('验证 trace')
  t.add(
    entry({
      id: 'st-1',
      title: '写测试',
      status: 'ok',
      durationMs: 1234,
      cost: { usd: 0.1234, inputTokens: 10, outputTokens: 20 },
      prompt: '给 Trace 写测试',
      text: '测试通过',
      raw: { command: 'node --test', exitCode: 0, stderr: '' },
    })
  )
  t.add(
    entry({
      id: 'st-2',
      title: '跑测试',
      status: 'failed',
      durationMs: 500,
      memberName: undefined,
      memberId: 'm2',
      role: undefined,
      cost: undefined,
      prompt: undefined,
      text: undefined,
      raw: undefined,
    })
  )
  t.finish()

  const md = t.toMarkdown()

  // 报告标题与元信息
  assert.match(md, /# 运行轨迹报告/)
  assert.match(md, /\*\*目标\*\*：验证 trace/)
  // 结果行：1 / 2 成功 · 1 失败
  assert.match(md, /\*\*结果\*\*：1 \/ 2 成功\s+·\s+1 失败/)
  // Token 行
  assert.match(md, /\*\*Token\*\*：输入 10 \/ 输出 20/)
  // 汇总表行（含花费格式化到 4 位）
  assert.match(md, /\| 1 \| st-1 写测试 \| 测试员 \| 测试 \| ok \| 1234ms \| \$0\.1234 \|/)
  // ★ 没上报成本的条目必须写「未知」，不能印 `$0.0000` ——
  //   印成 0 等于宣称"这次免费"，而事实是我们没拿到数据
  assert.match(md, /\| 2 \| st-2 跑测试 \| m2 \| - \| failed \| 500ms \| 未知 \|/)
  assert.doesNotMatch(md, /\$0\.0000/, '任何 `$0.0000` 都是谎：要么真花了钱、要么没数据')
  // ★ 总额后面要加注，不能让人以为那个 $ 数是确定的
  assert.match(md, /另有 1 个子任务未上报成本/)
  // Token 行要标明"只有几个上报了"，别让合计看起来是全量。
  // ⚠️ 分母是**实际执行过**的条数，不是子任务总数 ——
  //    没执行的子任务不可能上报 token，把它算进分母会让这句话失真
  assert.match(md, /仅 1 \/ 2 个实际执行的子任务上报/)
  // 每条子任务的详情小节
  assert.match(md, /## 1\. \[st-1\] 写测试 — 测试员 \/ 测试/)
  assert.match(md, /## 2\. \[st-2\] 跑测试 — m2 \/ 执行者/)
  assert.match(md, /- 状态：ok/)
  assert.match(md, /- 耗时：1234ms　退出码：0/)
  assert.match(md, /- 命令：`node --test`/)
  // 指令与产出小节
  assert.match(md, /\*\*给它的指令（节选）\*\*/)
  assert.match(md, /\*\*它的产出\*\*/)
  assert.match(md, /给 Trace 写测试/)
  assert.match(md, /测试通过/)
  // 缺 raw/prompt/text 时不写 stderr 行、不抛错
  assert.doesNotMatch(md, /stderr/)
})

test('toMarkdown：stderr 被单行化，且超长 prompt/text 会截断', () => {
  const t = new Trace('目标')
  t.add(
    entry({
      raw: { command: 'cmd', exitCode: 1, stderr: '第一行\n第二行' },
      prompt: 'p'.repeat(1000),
      text: 't'.repeat(4000),
    })
  )

  const md = t.toMarkdown()

  assert.match(md, /- stderr：`第一行 第二行`/) // 换行被替换为空格
  assert.match(md, /…（截断，原文 1000 字符）/)
  assert.match(md, /…（截断，原文 4000 字符）/)
  assert.ok(!md.includes('p'.repeat(1000)))
  assert.ok(!md.includes('t'.repeat(4000)))
})

test('toMarkdown：状态是唯一判据 —— 未知状态计入失败', () => {
  const t = new Trace('目标')
  t.add(entry({ status: 'cancelled' }))
  const md = t.toMarkdown()
  assert.match(md, /0 \/ 1 成功\s+·\s+1 失败/)
})

test('toMarkdown：假成功在报告里显形 —— 退出码 0 但产出可疑', () => {
  // 真实失败样本：2026-09-29 run_plan 首次报「3 / 3 成功」那次，
  // 多行 prompt 被命令行换行截断，成员其实只收到标题，于是回了句推诿。
  const fakeOk = '你这条消息只有标题【任务总目标】，还没有具体内容。请把具体任务补充一下。'

  const t = new Trace('协同验证')
  t.add(entry({ id: 's1', title: '第一个任务', text: fakeOk, quality: judgeOutput(fakeOk, { status: 'ok' }) }))
  t.add(entry({ id: 's2', title: '第二个任务', text: 'bravo', quality: judgeOutput('bravo', { status: 'ok' }) }))
  t.finish()

  const s = t.summary
  // 判定不改变 status / 流程：两条仍是成功
  assert.equal(s.okCount, 2)
  assert.equal(s.failedCount, 0)
  // 但有一条被标为产出可疑 —— 这才是"真正可用"的数量
  assert.equal(s.suspectCount, 1)

  const md = t.toMarkdown()
  // 报告头的警示块与计数
  assert.match(md, /其中 1 个产出可疑/)
  assert.match(md, /「成功」只说明没崩，不说明事办成了/)
  // 汇总表：可疑条标成 `ok ⚠️`，正常条保持裸 `ok`
  assert.match(md, /\| 1 \| s1 第一个任务 \| 测试员 \| 测试 \| ok ⚠️ \|/)
  assert.match(md, /\| 2 \| s2 第二个任务 \| 测试员 \| 测试 \| ok \|/)
  // 逐条详情里有可读说明
  assert.match(md, /- ⚠️ 产出可疑（template-refusal）/)
})

test('toMarkdown：干净轨迹不出现任何警示块（防误报）', () => {
  const t = new Trace('干净')
  t.add(entry({ text: 'bravo', quality: judgeOutput('bravo', { status: 'ok' }) }))
  const md = t.toMarkdown()
  assert.doesNotMatch(md, /产出可疑/)
  assert.doesNotMatch(md, /ok ⚠️/)
  assert.equal(t.summary.suspectCount, 0)
})

// ------------------------------- 文件改动在报告里要区分「未采集」和「零改动」

test('toMarkdown：改动文件非空 → 列出来', () => {
  const t = new Trace('改了东西')
  t.add(entry({ changedFiles: ['src/a.js', 'tests/b.test.mjs'] }))
  const md = t.toMarkdown()
  assert.match(md, /- 改动文件（2）：src\/a\.js、tests\/b\.test\.mjs/)
})

test('★ toMarkdown：采集到零改动 → 明确写「无（已完整采集）」', () => {
  const t = new Trace('没改')
  t.add(entry({ changedFiles: [] }))
  assert.match(t.toMarkdown(), /- 改动文件：\*\*无\*\*（已完整采集）/)
})

test('★★ toMarkdown：未采集 → 必须写"未采集"，不许写成"无改动"', () => {
  /*
   * 报告层最容易犯的错：把"我没看"渲染成"我看过了、没有"。
   * 读者据此会得出"这个成员什么都没干"的结论 —— 而事实是我们没采。
   */
  const t = new Trace('未采集')
  t.add(entry({ changedFiles: null }))
  const md = t.toMarkdown()
  assert.match(md, /- 改动文件：未采集/)
  assert.doesNotMatch(md, /改动文件：\*\*无\*\*/, '未采集不能说成"无改动"')
})

test('toMarkdown：改动文件很多时不刷屏（截前 12 个）', () => {
  const t = new Trace('改很多')
  t.add(entry({ changedFiles: Array.from({ length: 20 }, (_, i) => `f${i}.js`) }))
  const md = t.toMarkdown()
  assert.match(md, /- 改动文件（20）：/)
  assert.match(md, /等$|\s等/)
  assert.doesNotMatch(md, /f19\.js/, '第 20 个不该出现，避免报告被文件列表淹没')
})

// ------------------- 花费/Token 的诚实性：0 不是"免费"，是"没这个数"

test('★★ toMarkdown：积分计费的条目要单独说明，且总额加注', () => {
  const t = new Trace('混合计费')
  t.add(entry({ id: 's1', memberName: '克劳德', cost: { usd: 0.2056, inputTokens: 100 } }))
  t.add(entry({ id: 's2', memberName: 'Qoder', cost: { credits: 0.157647882 } }))

  const md = t.toMarkdown()
  assert.match(md, /\| 2 \| s2 .* \| 0\.157647882 积分 \|/, '积分条目要显示积分，不能显示成 $0')
  assert.match(md, /合计 0\.157648 积分，未折算成美元/)
  assert.match(md, /另有 1 个子任务按积分计费/)
  assert.match(md, /- 花费：0\.157647882 积分（该成员按积分计费，CLI 不返回美元成本）/)
  // 美元总额只统计真的报了美元的那条
  assert.match(md, /花费 \$0\.2056/)
})

test('★ toMarkdown：全部未上报成本 → 每格「未知」+ 总数也「未知」，绝不出现 $0', () => {
  const t = new Trace('全未知')
  t.add(entry({ id: 's1', cost: {} }))
  t.add(entry({ id: 's2', cost: undefined }))

  const md = t.toMarkdown()
  assert.equal((md.match(/未知/g) || []).length >= 2, true, '两条都要标未知')
  assert.match(md, /- 花费：未知（该成员未上报成本）/)
  // ★ 总数这一格也必须说"未知" —— 印 `花费 $0` 等于宣称"这次免费"
  assert.match(md, /花费 未知（2 个实际执行的子任务都没有上报成本）/)
  assert.doesNotMatch(md, /\$0\.0000/)
  assert.doesNotMatch(md, /花费 \$0/, '★ 零个上报的时候，$0 和 $0.0000 一样是谎')
})

// ── 总数那一格的四种情况 ──────────────────────────────────────────────
//
// 单格修好了还不够：总数那一格是另一处输出，`$${totalCostUsd}` 在"零个上报"时
// 正好等于 `$0` —— 同一个谎换到了汇总行。这是把报告样本打出来肉眼过的时候才看见的。

test('★ 花费总数：有人报了 → 印总额，并在没报齐时加注', () => {
  const t = new Trace('部分上报')
  t.add(entry({ id: 's1', cost: { usd: 0.1 } }))
  t.add(entry({ id: 's2', cost: {} }))
  const md = t.toMarkdown()
  assert.match(md, /花费 \$0\.1（⚠️ 另有 1 个子任务未上报成本/)
})

test('★ 花费总数：只有积分 → 明说"未折算成美元"，并给出积分合计', () => {
  const t = new Trace('只有积分')
  t.add(entry({ id: 's1', cost: { credits: 0.157648 } }))
  const md = t.toMarkdown()
  assert.match(md, /花费 未折算成美元（1 个子任务按积分计费，合计 0\.157648 积分）/)
  assert.doesNotMatch(md, /花费 \$/, '积分数不能折算成美元，一个 $ 符号都不该出现')
})

test('★ 花费总数：一条都没执行 → 印「无」——这是已知的零，可以印', () => {
  const t = new Trace('全跳过')
  t.add(skipEntry({ id: 's1' }))
  t.add(skipEntry({ id: 's2' }))
  t.finish()   // 这两条断言"整篇报告里不许出现未知"，所以夹具必须是**一次跑完的运行**
  const md = t.toMarkdown()
  assert.match(md, /花费 无（没有任何子任务被执行）/)
  assert.doesNotMatch(md, /未知/, '没执行的花费是已知的零，不是未知')
})

test('★ 花费总数：报齐了 → 不加任何注解（防噪音）', () => {
  const t = new Trace('全报齐')
  t.add(entry({ id: 's1', cost: { usd: 0.1 } }))
  const md = t.toMarkdown()
  assert.match(md, /花费 \$0\.1\n/)
  assert.doesNotMatch(md, /另有/)
})

test('★ toMarkdown：Token 一个都没上报 → 明说「未采集」', () => {
  const t = new Trace('无 token')
  t.add(entry({ cost: { usd: 0.1 } })) // 有成本但没 token（qoder 正是这个形态）
  const md = t.toMarkdown()
  assert.match(md, /\*\*Token\*\*：未采集（没有成员上报 token 用量）/)
  assert.doesNotMatch(md, /\*\*Token\*\*：输入 0 \/ 输出 0/, '印成 0/0 会让人以为"没消耗"')
})

test('防误报：全部子任务都报了美元成本 → 不加任何注解', () => {
  const t = new Trace('全报齐')
  t.add(entry({ id: 's1', cost: { usd: 0.1, inputTokens: 10, outputTokens: 5 } }))
  t.add(entry({ id: 's2', cost: { usd: 0.2, inputTokens: 20, outputTokens: 6 } }))
  t.finish()   // 同上：断言覆盖整篇，夹具得是一次跑完的运行
  const md = t.toMarkdown()
  assert.doesNotMatch(md, /另有/, '报齐了就别啰嗦')
  assert.doesNotMatch(md, /未知/)
  assert.doesNotMatch(md, /仅 \d+ \/ \d+ 个子任务上报/)
  assert.match(md, /花费 \$0\.3$|\*\*结果\*\*.*花费 \$0\.3/, '总额后面应直接结束')
})

// ---------------------------------------------------------------------------
// 单格格式化函数（导出给命令行复用）
//
// 为什么要单独钉：这些函数原来是**模块私有**的，命令行里于是各写了一份自己的
// `$${(usd || 0).toFixed(4)}` —— 报告把"没上报"改成"未知"时它没跟着改，
// 同一份数据报告印「0.157648 积分」、终端印「$0.0000」。导出之后由测试同时钉两件事：
// 三态各自的措辞，以及"导出的名字"本身（名字改了但没人用 → 静默退化成又一份私有实现）。
// ---------------------------------------------------------------------------

test('★ costOf：三态措辞 —— 报了美元 / 只报了积分 / 什么都没报', () => {
  assert.equal(costOf({ usd: 0.65 }), '$0.6500')
  assert.equal(costOf({ credits: 0.157648 }), '0.157648 积分')
  assert.equal(costOf({}), '未知', '没上报不许印 $0.0000 —— 那是把"没数据"说成"免费"')
  assert.equal(costOf(undefined), '未知')
})

test('★ costOf：报的是 0 美元 → 仍印 $0.0000（这是**真的测到了 0**，不是没数据）', () => {
  // 和上面那条一起构成这对判断的两半：`{}` 与 `{ usd: 0 }` 必须长得不一样。
  // 这正是 `typeof === 'number'` 而不是 `cost.usd || 0` 的意义。
  assert.equal(costOf({ usd: 0 }), '$0.0000')
})

test('★ costCell：未执行的条目花费是**已知的零**，印破折号而不是「未知」', () => {
  assert.equal(costCell({ status: 'skipped', cost: {} }), '—')
  assert.equal(costCell({ status: 'ok', cost: {} }), '未知', '执行过但没上报 → 未知')
})

test('★★ durationCell：没正常收尾 → 明说「未知」，绝不许印 0.0s', () => {
  /*
   * 这条是给 2026-09-29 那次回归钉的：
   * 抽 `advance()` 时 `run()` 结尾的 `trace.finish()` 被一起搬进了 `resume()`，
   * 于是整单首跑的 `finishedAt` 恒为 null、`durationMs` 恒为初始值 0，
   * 报告里「总耗时 0.0s」整整印了两轮 —— 没有任何断言覆盖它。
   */
  const never = new Trace('没跑完')
  assert.equal(durationCell(never.summary), '未知（运行没有正常收尾）')
  assert.doesNotMatch(durationCell(never.summary), /0\.0s/, '未收尾的 0 不是"0 秒"，是"没测到"')

  const done = new Trace('跑完了')
  done.finish()
  assert.match(durationCell(done.summary), /^\d+\.\ds$/)
})

test('★ 导出契约：命令行要用的这几个格式化函数必须都在（少一个就会各自再写一份）', () => {
  for (const [name, fn] of Object.entries({ costOf, costCell, costTotalCell, skipCell, durationCell })) {
    assert.equal(typeof fn, 'function', `${name} 必须导出且可调用`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 第三种状态：`skipped`（引擎没调用成员）
//
// 报告层是这条链的最后一站，也是最容易把谎话放出去的地方 ——
// 前面在编排层把"失败"和"没执行"分开了，如果这里又把它们合并印成"失败"，
// 那前面白分。同一类问题在数据层/传递层/报告层/界面层各长一遍，每层都要单独钉。
// ═══════════════════════════════════════════════════════════════════════════

test('★★ summary：skipped 不许混进 failedCount —— 「失败」和「没执行」是两件事', () => {
  const t = new Trace('三种状态')
  t.add(entry({ id: 's1', status: 'ok', cost: { usd: 0.1 } }))
  t.add(entry({ id: 's2', status: 'failed', cost: {} }))
  t.add(skipEntry({ id: 's3', skipKind: 'blocked' }))
  t.add(skipEntry({ id: 's4', skipKind: 'aborted' }))
  t.finish()
  const s = t.summary

  assert.equal(s.subtaskCount, 4)
  assert.equal(s.executedCount, 2, '只有 2 条真的调用过成员')
  assert.equal(s.okCount, 1)
  assert.equal(s.failedCount, 1, '★ 只有 s2 是失败；说 3 个失败就是假的')
  assert.equal(s.skippedCount, 2)
  assert.deepEqual(s.skippedByKind, { blocked: 1, aborted: 1, budget: 0, user: 0 })
  // ★ 成本的分母必须是"执行过的条数"，否则没执行的条目会被算成"没上报成本"
  assert.equal(s.costUnknownCount, 1, '未上报成本的只有 s2 那条失败的')
})

test('★ summary：成本分母排除了 skipped —— 否则注脚上的数字是假的', () => {
  const t = new Trace('分母')
  t.add(entry({ id: 's1', cost: { usd: 0.1 } }))
  t.add(skipEntry({ id: 's2' }))
  t.add(skipEntry({ id: 's3' }))
  t.finish()
  const md = t.toMarkdown()
  // 两条 skipped 的花费是「已知的零」，不该被算进"另有 N 条未上报成本"
  assert.equal(t.summary.costUnknownCount, 0)
  assert.doesNotMatch(md, /另有 \d+ 个子任务未上报成本/, 'skipped 不是"没上报"，是"没有消耗"')
})

test('★ toMarkdown：skipped 的花费格印 `—`（已知的零），不是 `未知`', () => {
  const t = new Trace('花费格')
  t.add(entry({ id: 's1', cost: {} }))
  t.add(skipEntry({ id: 's2' }))
  const md = t.toMarkdown()
  // 没上报成本的那条印"未知"
  assert.match(md, /\| 1 \| s1 .*\| 未知 \|/)
  // ★ 没执行的那条印"—" —— 印"未知"会被读成"花了但没记下来"
  assert.match(md, /\| 2 \| s2 .*\| 未执行 \| 0ms \| — \|/)
  assert.doesNotMatch(md, /\$0\.0000/)
})

test('★ toMarkdown：结果行把「未执行」单独列出来并说明原因', () => {
  const t = new Trace('结果行')
  t.add(entry({ id: 's1', status: 'ok', cost: { usd: 0.1 } }))
  t.add(entry({ id: 's2', status: 'failed', cost: {} }))
  t.add(skipEntry({ id: 's3', skipKind: 'blocked' }))
  t.add(skipEntry({ id: 's4', skipKind: 'aborted' }))
  t.add(skipEntry({ id: 's5', skipKind: 'budget' }))
  const md = t.toMarkdown()
  assert.match(md, /1 \/ 5 成功\s+·\s+1 失败\s+·\s+3 未执行（引擎未调用成员：1 条依赖断链、1 条策略中止、1 条预算上限）/)
})

test('★ toMarkdown：没有未执行条目时，结果行不许出现「未执行」三个字', () => {
  const t = new Trace('干净')
  t.add(entry({ id: 's1', cost: { usd: 0.1 } }))
  const md = t.toMarkdown()
  assert.doesNotMatch(md, /未执行/, '没这事就别提，免得变成噪音')
})

test('★ toMarkdown：skipped 走短记录 —— 不印「给它的指令」和「它的产出」', () => {
  /*
   * 那两格本来就是空的。印出来会让人以为"它跑了、只是什么都没交"，
   * 而事实是**引擎压根没调用它**。空壳比没有更误导。
   */
  const t = new Trace('短记录')
  t.add(skipEntry({ id: 's4', skipKind: 'blocked', text: '未执行：依赖的 s3 没有可用产出', dependsOn: ['s3'] }))
  const md = t.toMarkdown()
  assert.match(md, /## 1\. \[s4\] 没跑的活 — 桩成员 \/ 执行者/)
  assert.match(md, /- 状态：\*\*未执行\*\*（引擎没有调用成员 —— 本次没有产生任何消耗）/)
  assert.match(md, /- 原因：未执行：依赖的 s3 没有可用产出/)
  assert.doesNotMatch(md, /\*\*给它的指令（节选）\*\*/)
  assert.doesNotMatch(md, /\*\*它的产出\*\*/)
})

test('★★ toMarkdown：带着上游缺口跑出来的 ok，必须和干净的 ok 长得不一样', () => {
  /*
   * 这是 `salvage` 策略的安全带。
   * 一条"在上游缺失下硬跑出来的结论"如果和"输入齐备的结论"在报告里毫无区别，
   * 那"半份成果"就被包装成了"完整成果" —— 这正是这一整轮要防的事。
   */
  const t = new Trace('缺口')
  t.add(entry({ id: 's4', status: 'ok', degradedUpstream: ['s3'], cost: { usd: 0.2 } }))
  t.add(entry({ id: 's5', status: 'ok', cost: { usd: 0.1 } }))
  const md = t.toMarkdown()

  // 表格里要能一眼看出差别
  assert.match(md, /\| 1 \| s4 .*\| ok ⚠️缺口 \|/)
  assert.match(md, /\| 2 \| s5 .*\| ok \|/)
  // 顶部要有汇总警告
  assert.match(md, /其中 1 个是在上游有缺口的情况下跑的/)
  assert.match(md, /结论\*\*不完整\*\*/)
  // 逐条详情里要说清缺的是谁
  assert.match(md, /- ⚠️ \*\*上游缺口\*\*：本任务是在 s3 没有可用产出的情况下执行的/)
  // 数字也要对得上
  assert.equal(t.summary.degradedCount, 1)
  assert.equal(t.summary.okCount, 2, '它本身是 ok —— 缺口是另一维信息，不该篡改状态')
})

test('★ toMarkdown：没有缺口时不许出现缺口警告（防噪音）', () => {
  // 目标字符串里刻意不含"缺口"两个字 —— 否则断言会命中报告标题，测了个寂寞
  const t = new Trace('一次干净的运行')
  t.add(entry({ id: 's1', status: 'ok', degradedUpstream: [], cost: { usd: 0.1 } }))
  const md = t.toMarkdown()
  assert.doesNotMatch(md, /上游缺口/)
  assert.doesNotMatch(md, /缺口/)
  assert.equal(t.summary.degradedCount, 0)
})

// ── upsert：单卡片重跑不许让同一个子任务出现两条 ──────────────────────

test('★★ upsert：同一个 id 就地覆盖，不新增记录、index 也不漂移', () => {
  /*
   * 单卡片重跑必然要"用新结果替换旧结果"。如果这里用 `add`，
   * 报告里同一个子任务会先有一条 failed 再有一条 ok —— `subtaskCount`、
   * "3/5 成功"这些数字全都不再等于计划条数，而"轨迹条数 === 计划条数"
   * 正是上一轮拿来当"不许无声消失"的横切保证。
   */
  const t = new Trace('重跑')
  t.add(entry({ id: 's1', status: 'ok' }))
  t.add(entry({ id: 's2', status: 'failed', text: '第一次失败' }))
  t.add(entry({ id: 's3', status: 'ok' }))

  const row = t.upsert(entry({ id: 's2', status: 'ok', text: '重跑成功' }))

  assert.equal(t.entries.length, 3, '★ 不许从 3 条变成 4 条')
  assert.equal(row.index, 2, '★ index 代表"在计划里的位置"，重跑不该让它漂移')
  assert.equal(t.entries.filter((e) => e.id === 's2').length, 1)
  assert.deepEqual(t.entries.map((e) => e.id), ['s1', 's2', 's3'], '顺序也不该乱')
  assert.equal(t.entries[1].status, 'ok')
  assert.equal(t.entries[1].text, '重跑成功')
  assert.equal(t.summary.okCount, 3)
  assert.equal(t.summary.failedCount, 0)
})

test('upsert：没有同 id 时退化成新增（首跑与续跑共用同一条路径）', () => {
  const t = new Trace('新增')
  const a = t.upsert(entry({ id: 's1' }))
  const b = t.upsert(entry({ id: 's2' }))
  assert.equal(t.entries.length, 2)
  assert.equal(a.index, 1)
  assert.equal(b.index, 2)
  assert.equal(t.entries[0], a)
})

test('★ upsert 之后报告里只有一条记录、只算一次 —— 数字不许被重跑污染', () => {
  const t = new Trace('报告')
  t.add(entry({ id: 's1' }))
  t.add(entry({ id: 's2', status: 'failed', cost: {} }))
  t.upsert(entry({ id: 's2', status: 'ok', cost: { usd: 0.2 } }))
  const md = t.toMarkdown()
  assert.equal((md.match(/\| 2 \| s2 /g) || []).length, 1, '表格里 s2 只能出现一行')
  assert.equal((md.match(/## 2\. \[s2\]/g) || []).length, 1, '详情里也只能有一节')
  assert.match(md, /2 \/ 2 成功/)
  assert.match(md, /0 失败/)
})
