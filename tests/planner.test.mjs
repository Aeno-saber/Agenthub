/**
 * planner.js 单元测试 —— extractJson（从模型输出里抠 JSON）
 *
 * 运行：node --test tests/planner.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { readFileSync } from 'node:fs'

import { extractJson, extractJsonLoose, buildPlannerPrompt } from '../src/engine/planner.js'

// ------------------------------------------------------------ 正常路径

test('extractJson：标准 ```json 围栏代码块', () => {
  const text = ['```json', '{"goal":"写文档","subtasks":[]}', '```'].join('\n')
  const res = extractJson(text)
  assert.deepEqual(res, { goal: '写文档', subtasks: [] })
})

test('extractJson：无 json 标签的围栏代码块也能解析', () => {
  const text = ['```', '{"a":1}', '```'].join('\n')
  assert.deepEqual(extractJson(text), { a: 1 })
})

test('extractJson：裸 JSON 字符串', () => {
  assert.deepEqual(extractJson('{"goal":"x"}'), { goal: 'x' })
})

test('extractJson：前后夹着解释文字的 JSON（带围栏）', () => {
  const text = [
    '好的，这是拆解结果，请查收：',
    '```json',
    '{"goal":"上线","subtasks":[{"id":"s1","dependsOn":[]}]}',
    '```',
    '希望有帮助！',
  ].join('\n')
  assert.deepEqual(extractJson(text), {
    goal: '上线',
    subtasks: [{ id: 's1', dependsOn: [] }],
  })
})

test('extractJson：前后夹着解释文字且无围栏', () => {
  const text = '结果是 {"a":1,"b":2} 以上'
  assert.deepEqual(extractJson(text), { a: 1, b: 2 })
})

test('extractJson：保留嵌套结构（不丢字段）', () => {
  const text = '{"goal":"g","subtasks":[{"id":"s1","prompt":"做 A"},{"id":"s2","prompt":"做 B"}]}'
  const res = extractJson(text)
  assert.equal(res.subtasks.length, 2)
  assert.equal(res.subtasks[1].prompt, '做 B')
})

// ------------------------------------------------------------ 边界值

test('extractJson：{} 空对象能解析', () => {
  assert.deepEqual(extractJson('{}'), {})
})

test('extractJson：围栏内前后有多余空白', () => {
  const text = '```json\n\n   {"a":1}   \n\n```'
  assert.deepEqual(extractJson(text), { a: 1 })
})

// ------------------------------------------------------------ 异常分支

test('extractJson：完全非法的文本 → null', () => {
  assert.equal(extractJson('这是一段纯粹的自然语言，没有任何大括号结构。'), null)
})

test('extractJson：有大括号但不是合法 JSON → null', () => {
  assert.equal(extractJson('{这不是合法的 json}'), null)
})

test('extractJson：空字符串 → null', () => {
  assert.equal(extractJson(''), null)
})

test('extractJson：null → null', () => {
  assert.equal(extractJson(null), null)
})

test('extractJson：undefined → null', () => {
  assert.equal(extractJson(undefined), null)
})

test('extractJson：只有空白字符 → null', () => {
  assert.equal(extractJson('   \n\t  '), null)
})

test('extractJson：只有开始括号没有结束括号 → null', () => {
  assert.equal(extractJson('{"a":1'), null)
})

// ------------------------------------------------------------ 截断抢救（extractJsonLoose）
//
// 这一组来自一次真实踩坑：规划者给每个子任务写了很长的 prompt，
// 输出到第 2 个子任务中途就被截断，结尾的 ``` 围栏压根没吐出来。
// extractJson 要求围栏成对 → 匹配失败 → 退回全文 + lastIndexOf('}')
// → 不完整 JSON → parse 抛错 → null → 界面只说「没拆出可用计划」，
// 看不出是"被截断了"，而且整个任务因此起不来（其实前面写好的子任务是能用的）。

test('extractJsonLoose：输出完整时不标记为抢救', () => {
  const text = '```json\n{"goal":"g","subtasks":[{"id":"s1","prompt":"做点事"}]}\n```'
  const r = extractJsonLoose(text, { minArrayField: 'subtasks' })
  assert.equal(r.repaired, false)
  assert.equal(r.reason, '')
  assert.equal(r.value.subtasks.length, 1)
})

test('extractJsonLoose：★ 真实踩坑形态 —— 截断在第二个子任务中途、结尾围栏缺失', () => {
  const text = [
    '```json',
    '{',
    '  "goal": "补强产出有效性判定",',
    '  "subtasks": [',
    '    {',
    '      "id": "s1",',
    '      "title": "规则级缺口盘点",',
    '      "memberId": "qoder",',
    '      "role": "代码主笔",',
    '      "prompt": "读 src/engine/quality.js 全部 109 行",',
    '      "dependsOn": []',
    '    },',
    '    {',
    '      "id": "s2",',
    '      "title": "真实运行数据验证漏判",',
    '      "memberId": "cursor",',
    '      "role": "测试",',
    '      "prompt": "任务：用真实运行记录验证哪些废产出现在被判成了 ok，给出可复现证',
  ].join('\n')

  // 前提：严格版确实拿不到 —— 这正是界面上显示「没拆出可用计划」的原因
  assert.equal(extractJson(text), null)

  const r = extractJsonLoose(text, { minArrayField: 'subtasks', minItems: 1 })
  assert.equal(r.repaired, true)
  assert.ok(r.value, '应该抢救出可解析的计划')
  assert.equal(r.value.goal, '补强产出有效性判定')
  assert.equal(r.value.subtasks.length, 1, '只保住完整闭合的那一个')
  assert.equal(r.value.subtasks[0].id, 's1')
  assert.match(r.reason, /截断/)
})

test('extractJsonLoose：截断在字符串中间 → 补引号后救回', () => {
  const text = '{"goal":"g","subtasks":[{"id":"s1","prompt":"读代码'
  const r = extractJsonLoose(text, { minArrayField: 'subtasks', minItems: 1 })
  assert.equal(r.repaired, true)
  assert.equal(r.value.subtasks[0].prompt, '读代码')
})

test('★ extractJsonLoose：截断导致子任务缺 prompt → 宁可不救（残缺计划引擎会拒）', () => {
  /*
   * 这条断言在 2026-09-29 第二轮真跑之后**改了期望**。
   *
   * 原来期望「回退掉不完整项后仍返回 1 个子任务」—— 可那个子任务是没 prompt 的。
   * 实测后果很实在：界面照常渲染计划表、照常放行「确认执行」，
   * 直到服务端 `validatePlan` 才报「子任务 s3 缺少 prompt」，用户白点一次，
   * 而且界面上完全没提示到底哪里缺。
   *
   * 所以现在的原则是：**抢救的产物必须能通过引擎校验，否则就当没救出来。**
   */
  const text = '{"goal":"g","subtasks":[{"id":"s1","title":"t","memberId":"cursor","role":"测试","prompt": '
  const r = extractJsonLoose(text, { minArrayField: 'subtasks', minItems: 1 })
  assert.equal(r.value, null, '唯一的子任务残缺 → 整份计划不可用')
  assert.equal(r.repaired, false)
})

test('extractJsonLoose：形状不符（抢救出来的东西里没有 subtasks）→ 宁可返回 null', () => {
  // 关键：不能因为"能 parse"就交出没有 subtasks 的假计划
  const r = extractJsonLoose('{"a":1', { minArrayField: 'subtasks', minItems: 1 })
  assert.equal(r.value, null)
  assert.equal(r.repaired, false)
})

test('★★ extractJsonLoose：残缺子任务必须被丢掉，只保留完整的那几个', () => {
  /*
   * 第二轮真跑的现场形态：抢救回退若干段后，勉强拼出一个「有 3 个子任务」的 JSON，
   * 但第三个只剩 {id,title,memberId,role}，没有 prompt。
   * 旧校验只看数组长度 → 判定"抢救成功" → 界面放行 → 服务端才拒。
   *
   * 正确行为：把残缺的那个丢掉，交出前两个完整的。
   */
  const text = [
    '```json',
    '{"goal":"找缺口","subtasks":[',
    '  {"id":"s1","title":"静态盘点","memberId":"claude","role":"代码主笔","prompt":"通读 quality.js","dependsOn":[]},',
    '  {"id":"s2","title":"实测验证","memberId":"cursor","role":"测试","prompt":"用真实数据实测","dependsOn":[]},',
    '  {"id":"s3","title":"评审","memberId":"qoder","role":"评审"',
  ].join('\n')

  const r = extractJsonLoose(text, { minArrayField: 'subtasks', minItems: 1 })
  assert.equal(r.repaired, true)
  assert.ok(r.value, '应抢救出完整的那部分')
  assert.deepEqual(r.value.subtasks.map((s) => s.id), ['s1', 's2'], '★ 残缺的 s3 必须被丢掉')
  for (const s of r.value.subtasks) {
    assert.ok(s.prompt && s.prompt.trim(), `${s.id} 的 prompt 不能为空`)
  }
})

test('extractJsonLoose：prompt 是空白字符串的子任务同样不合格', () => {
  const text = '{"goal":"g","subtasks":[{"id":"s1","prompt":""},{"id":"s2","prompt":"  "}]}'
  const r = extractJsonLoose(text, { minArrayField: 'subtasks', minItems: 1 })
  assert.equal(r.value, null, '全是空 prompt 的计划没有一处可用，就该判没拆出来')
})

test('extractJsonLoose：严格版 JSON 合法但字段残缺 → 退化为只保留完整的那部分', () => {
  /*
   * 注意这里期望的不是 null：s1 是**完整**的，没理由把它一起扔掉。
   * 这也说明形状校验放在"严格版之前"是划算的 ——
   * 语法合法但 s2 缺 prompt 时，不会直接放行，而是退到抢救路径去保住 s1。
   */
  const text = '```json\n{"goal":"g","subtasks":[{"id":"s1","prompt":"做A"},{"id":"s2"}]}\n```'
  const r = extractJsonLoose(text, { minArrayField: 'subtasks', minItems: 1 })
  assert.ok(r.value, 's1 是完整的，应该保住')
  assert.deepEqual(r.value.subtasks.map((s) => s.id), ['s1'])
  assert.equal(r.repaired, true, '结果来自抢救路径，必须如实标注')
})

test('extractJsonLoose：自定义 itemFields 能改必填字段', () => {
  const text = '{"items":[{"name":"a","body":"正文"}],"extra":'
  const r = extractJsonLoose(text, { minArrayField: 'items', itemFields: ['name', 'body'] })
  assert.equal(r.value.items.length, 1)
  assert.equal(r.value.items[0].name, 'a')
})

test('extractJsonLoose：subtasks 是空数组也判为不合格（要求至少 1 项）', () => {
  const r = extractJsonLoose('{"goal":"g","subtasks":[', { minArrayField: 'subtasks', minItems: 1 })
  assert.equal(r.value, null)
})

test('extractJsonLoose：完全不是 JSON → null，且不谎报"抢救过"', () => {
  const r = extractJsonLoose('纯自然语言，没有大括号。', { minArrayField: 'subtasks' })
  assert.equal(r.value, null)
  assert.equal(r.repaired, false)
})

test('extractJsonLoose：空输入 / null → null', () => {
  assert.equal(extractJsonLoose('').value, null)
  assert.equal(extractJsonLoose(null).value, null)
})

test('extractJsonLoose：不传 minArrayField 时按纯 JSON 抢救（不给形状约束）', () => {
  const r = extractJsonLoose('{"a":1', {})
  assert.equal(r.value.a, 1)
  assert.equal(r.repaired, true)
})

test('extractJsonLoose：嵌套字符串里的花括号不会被误当结构', () => {
  // prompt 里带 JSON 片段是常见情况，括号栈必须能正确跳过字符串内容
  const text = '{"goal":"g","subtasks":[{"id":"s1","prompt":"输出格式：{\\"k\\":1}"},{"id":"s2","prompt":"再来'
  const r = extractJsonLoose(text, { minArrayField: 'subtasks', minItems: 1 })
  assert.equal(r.repaired, true)
  assert.equal(r.value.subtasks.length, 1, '应停在 s1 结束处而不是被 s1 prompt 里的括号带偏')
  assert.equal(r.value.subtasks[0].id, 's1')
  assert.equal(r.value.subtasks[0].prompt, '输出格式：{"k":1}')
})

// ─────────────── 名单里的"计费"：曾经挂着假的 free 标签（2026-09-29 补）

test('★ buildPlannerPrompt：只陈述计费口径，不再出现 "free"', () => {
  /*
   * 背景：名单以前给成员标了 `free` 能力标签，而这个标签是错的 ——
   * 实测 qoder 每次调用都在扣积分（一次短问答 0.1576 积分）。
   * 规划者看得见标签，于是会"为了省钱"把重活派给看起来免费的成员：
   * 第三轮真跑里那个跑了 6.5 分钟的子任务就是这么落到 qoder 头上的。
   */
  const members = [
    { id: 'claude', name: 'Claude', capabilities: ['code'], billing: 'subscription' },
    { id: 'qoder', name: 'Qoder', capabilities: ['code'], billing: 'credits' },
    { id: 'mystery', name: 'Mystery', capabilities: [] }, // 没写 billing
  ]
  const p = buildPlannerPrompt('目标', members)

  assert.match(p, /qoder（Qoder）：能力 \[code\] · 计费 \[按积分扣费/)
  assert.match(p, /claude（Claude）：能力 \[code\] · 计费 \[订阅内/)
  assert.match(p, /mystery（Mystery）：能力 \[无\] · 计费 \[未知\]/, '缺 billing 时要写未知，不能编')
  assert.doesNotMatch(p, /\bfree\b/i, '"free" 这个假标签不能再出现在规划者眼前')
  assert.match(p, /选人看能力匹配，不看计费口径/)
})

test('★ 真实成员配置：没有人挂 free，且都声明了 billing', () => {
  const cfg = JSON.parse(readFileSync(new URL('../src/config/members.json', import.meta.url), 'utf8'))
  const list = Array.isArray(cfg) ? cfg : cfg.members || []
  assert.ok(list.length >= 5)
  for (const m of list) {
    assert.equal((m.capabilities || []).includes('free'), false, `${m.id} 不该挂 free 标签`)
    assert.ok(m.billing, `${m.id} 应声明 billing（否则规划者只能看到"未知"）`)
  }
})

test('★ qoder 的真配置确实会解析出 credits（配置与解析器接得上）', () => {
  // 这条盯的是"配置写了 creditsPath 但拼错"这类最没价值的绿
  const cfg = JSON.parse(readFileSync(new URL('../src/config/members.json', import.meta.url), 'utf8'))
  const qoder = (Array.isArray(cfg) ? cfg : cfg.members).find((m) => m.id === 'qoder')
  assert.equal(qoder.outputFormat, 'json')
  assert.equal(qoder.textPath, 'result')
  assert.equal(qoder.creditsPath, 'total_credits')
  assert.equal(qoder.billing, 'credits')
})

// ─────────────── 防截断的两条上限：跟着规划者走（2026-10-02 补）

test('★ 拆解上限跟规划者的能力走：流式的放宽，默认仍旧保守', () => {
  /*
   * 两条上限（子任务 2-6 个、prompt ≤150 字）是为一次真实事故加的：
   * 规划模型的输出写到一半被截断，后面的子任务整个丢掉。见 docs/05 第七节。
   *
   * 但那是"一次性吐一大段"的模型的毛病。codex 的 `exec --json` 是逐事件回来的，
   * 对它继续压这两条等于白扔掉规划能力 —— 拆得少、指令含糊，反而更容易在执行阶段失败。
   *
   * 所以关键是**两边都要测**：放宽的那边要真的放宽，
   * 默认那边要一个字都没动（不然就是拿别人的安全换这边的能力）。
   */
  const members = [{ id: 'codex', name: 'Codex', capabilities: ['code'], billing: 'subscription' }]

  const strict = buildPlannerPrompt('目标', members)
  assert.match(strict, /2-6 个/, '默认口径必须还是 2-6 个')
  assert.match(strict, /150 字以内/, '默认口径必须还有 150 字上限')
  assert.match(strict, /输出越短越安全/, '默认口径必须保留"截断"这条原因说明')

  const wide = buildPlannerPrompt('目标', members, '', [], { streamsOutput: true })
  assert.doesNotMatch(wide, /2-6 个/, '流式规划者不该再被 2-6 卡住')
  assert.doesNotMatch(wide, /150 字以内/, '流式规划者不该再被字数卡住')
  assert.match(wide, /3-10 个/, '放宽后要给出新的数量区间，不能只是删掉一句')
  assert.match(wide, /不会被截断/, '要说明为什么可以不省字数 —— 否则读的人不知道为什么这条变了')

  // 其余规则一条都不许丢
  for (const p of [strict, wide]) {
    assert.match(p, /【输出格式】/)
    assert.match(p, /dependsOn/)
    assert.match(p, /选人看能力匹配，不看计费口径/)
    assert.match(p, /每个子任务只派给一个成员/)
  }
})