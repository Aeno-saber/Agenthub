/**
 * 角色目录的一致性测试 —— `src/roles.js` 与另外三处用它的人对不对得上。
 *
 * 运行：node --test tests/roles.test.mjs
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么这个文件值得存在：
 *
 * 角色这件事原来写在**三个地方**（前端一份数组、`rolePrompt()` 一份预设表、
 * 规划者提示词一条硬编码的列表），三份互相漂移，而且已经漂出了一件真事：
 * 前端下拉框的默认值是「执行者」，可 `rolePrompt()` 里**没有这个角色**，
 * 于是"用默认角色"这条最常见的路径，落到模型头上的只有一句兜底的话。
 *
 * 现在只有 `src/roles.js` 一份。但"只有一份"本身不会自动保持 ——
 * 只要有人再往 `rolePrompt()` 里加一个 `if`，漂移就回来了，而且**不会报错**：
 * 界面上照样有那个角色，只是系统提示词悄悄变回兜底。这类失败全都不出声，
 * 所以只能靠断言把它顶住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { ROLES, ROLE_LABELS, findRole, roleCatalogText } from '../src/roles.js'
import { rolePrompt } from '../src/adapters/base.js'
import { buildPlannerPrompt } from '../src/engine/planner.js'

// ------------------------------------------------------------ 目录本身

test('目录里的每条角色，必填字段都不为空', () => {
  assert.ok(ROLES.length >= 8, `角色太少（${ROLES.length} 个）—— 分工的粒度就靠这份目录`)
  for (const r of ROLES) {
    assert.ok(r.label, '缺 label')
    assert.ok(r.glyph, `${r.label} 缺 glyph（分工卡片上的那个字）`)
    assert.ok(r.duty, `${r.label} 缺 duty（职责）—— 这是"分工再详细点"的正文`)
    assert.ok(r.deliverable, `${r.label} 缺 deliverable（交付物）—— 没有它这一步就没法验收`)
    assert.ok(Array.isArray(r.needs), `${r.label} 的 needs 必须是数组（空数组 = 谁都能干）`)
    assert.equal(typeof r.write, 'boolean', `${r.label} 的 write 必须是布尔值`)
    assert.ok(r.prompt && r.prompt.length >= 12, `${r.label} 的 prompt 太短，等于没写`)
  }
})

test('label 唯一 —— 它是三处对齐的接缝，重名就等于断链', () => {
  /*
   * `role` 这个字段是**给模型看的**（规划者输出的就是中文短语），
   * 所以 label 同时充当了 id。重名的话 `findRole()` 只会返回第一个，
   * 第二段 prompt 永远不会被用上，而且没有任何报错。
   */
  assert.equal(new Set(ROLE_LABELS).size, ROLE_LABELS.length, '有重复的 label')
})

test('needs 只写 members.json 里真实存在的能力标签', () => {
  /*
   * needs 是拿去和成员的 `capabilities` 做交集的。写一个没人有的标签，
   * 结果是**每个成员都被判为不匹配** —— 界面上满屏警告，用户很快就不看了，
   * 于是真正的派错人被淹没在噪音里。宁可不写（空数组 = 谁都能干）。
   */
  const known = new Set(['code', 'shell', 'doc', 'review'])
  for (const r of ROLES) {
    for (const n of r.needs) {
      assert.ok(known.has(n), `${r.label} 声明了不存在的能力标签「${n}」`)
    }
  }
})

// ------------------------------------------------------------ 与 rolePrompt 对齐

test('★★ 目录里每一个角色，查回来的 prompt 都不是兜底那句', () => {
  /*
   * 这条就是那个真实空洞的回归测试。
   * 兜底的句式是「你在本次任务中承担的角色是：X。」——
   * 一旦哪个角色掉回兜底，说明目录和 rolePrompt() 对不上了。
   */
  for (const r of ROLES) {
    const p = rolePrompt(r.label)
    assert.equal(p, r.prompt, `${r.label} 展开出来的 prompt 和目录里那一段对不上`)
    assert.doesNotMatch(p, /^你在本次任务中承担的角色是：/, `${r.label} 掉回了兜底 —— 等于没写`)
  }
})

test('★ 「执行者」必须有真预设 —— 它是前端下拉框的默认值', () => {
  // 单独挑出来是因为它正是当初漏掉的那一个：最常被用到，却唯独没有预设
  const p = rolePrompt('执行者')
  assert.ok(p.startsWith('你负责执行这一步'), `执行者展开成了：${p}`)
})

test('未知角色仍然走兜底，不抛异常', () => {
  /*
   * 计划可能是旧版本 localStorage 恢复出来的，也可能被手改过。
   * 认不出的角色不该让整步任务失去角色说明，更不该把渲染整个打挂。
   */
  assert.equal(rolePrompt('首席摸鱼官'), '你在本次任务中承担的角色是：首席摸鱼官。')
  assert.equal(rolePrompt(''), '')
  assert.equal(rolePrompt(undefined), '')
  assert.equal(findRole('不存在的角色'), null)
})

// ------------------------------------------------------------ 与规划者提示词对齐

test('★★ 规划者提示词里的角色清单，逐条来自目录（带职责与交付物）', () => {
  const p = buildPlannerPrompt('目标', [{ id: 'claude', name: 'Claude', capabilities: ['code'], billing: 'subscription' }])
  for (const r of ROLES) {
    assert.ok(p.includes(`- ${r.label}：${r.duty}`), `${r.label} 的职责没进提示词`)
    assert.ok(p.includes(`交付物：${r.deliverable}`), `${r.label} 的交付物没进提示词`)
  }
  // 老写法是"role 用中文短语，例如：A / B / C" —— 只说名字不说含义，模型只能按字面猜
  assert.doesNotMatch(p, /role 用中文短语，例如/, '硬编码的角色示例应该已经被目录取代')
})

test('★ 指定分工时，提示词里出现【指定分工】并且逐字列出这些角色', () => {
  const members = [{ id: 'claude', name: 'Claude', capabilities: ['code', 'doc'], billing: 'subscription' }]
  const p = buildPlannerPrompt('目标', members, '', ['代码主笔', '评审'])

  assert.match(p, /【指定分工】/)
  assert.match(p, /- 代码主笔\n- 评审\n/)
  assert.match(p, /至少.*要出现在一个子任务里/)
  // 没指定时不能出现这一段 —— 否则规划者会以为有个不存在的约束
  const q = buildPlannerPrompt('目标', members, '', [])
  assert.doesNotMatch(q, /【指定分工】/)
})

test('★ 目录文本自带能力要求，规划者能据此避开派错人', () => {
  const text = roleCatalogText()
  assert.match(text, /- 代码主笔：.*需要能力：code；会改文件/)
  assert.match(text, /- 评审：.*需要能力：review；不改文件/)
  // 空 needs 必须说"不限"，不能留一段空白让人以为漏了
  assert.match(text, /- 调研：.*需要能力：不限/)
})
