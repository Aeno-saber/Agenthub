/**
 * 权限档位 —— 用户选的这一档，到底有没有真的传下去。
 *
 * ## 起因（2026-09-29 审计）
 *
 * 当时三个适配器都把权限翻译写成同一句话：
 *
 * ```js
 * permissionArgs(level) {
 *   return map[level] || map[this.spec.defaultPermission] || []
 * }
 * ```
 *
 * 这句话会把两种「档位没有生效」的情况**静默吞掉**：
 *  1. 请求的档位**没配** → 拿默认档的参数顶上，而界面仍显示用户选的那一档；
 *  2. 请求的档位**配成空数组** → 什么都不传，等于该成员无法用参数表达这一档。
 *
 * 实测（`node tests/perm-audit.mjs`）：trae 的 `readonly` 与 `plan` 都配成 `[]`，
 * 四个档位实际塌缩成两组；dsh 更是四档全 `[]`。
 *
 * 而编排器当时只看 `WRITE_PERMISSIONS.has(permission)` 决定要不要采集文件改动 ——
 * 于是 trae 的只读档**既不采集、也永远不会被判定**。成员真写了文件没人知道，
 * 而界面上写着「只读 —— 能读，不改文件、不跑命令」。
 *
 * 这组测试钉的就是「再也不能静默」：档位有没有真的传下去，必须是个**可断言的事实**。
 *
 * ⚠️ 下面若干条会把 members.json 的**当前**配置固化下来。这是故意的：
 * 哪天谁把 trae 的只读档配上了真参数，测试会红 —— 那是"这条缺陷已修复"的信号，
 * 不是噪音。红的时候请连同注释一起更新，别把断言删掉了事。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import process from 'node:process'

import { loadRegistry } from '../src/adapters/index.js'
import { describePermission, isWriteCapable, PERMISSION_LEVELS } from '../src/adapters/base.js'
import { GenericAdapter } from '../src/adapters/generic.js'
import { memberMayWrite, WRITE_PERMISSIONS } from '../src/engine/quality.js'

/** 真实配置 —— 夹具必须是它，否则测的是一条现实中不存在的路径 */
const reg = loadRegistry()
const specOf = (id) => reg.get(id)?.spec

// ─────────────────────────── describePermission：把"没说出口的"变成可读的

test('★ describePermission：四档齐全的成员（claude）→ 每一档都是 exact 且 expressible', () => {
  const spec = specOf('claude')
  for (const lv of PERMISSION_LEVELS) {
    const info = describePermission(spec, lv)
    assert.equal(info.source, 'exact', `${lv} 有专属配置`)
    assert.equal(info.effectiveLevel, lv, '生效的就是用户请求的那一档')
    assert.ok(info.args.length > 0, `${lv} 真的传了参数`)
    assert.equal(info.expressible, true)
  }
})

test('★★ describePermission：档位配成空数组（trae 的 readonly）→ exact 但**不可表达**', () => {
  const info = describePermission(specOf('trae'), 'readonly')
  assert.equal(info.source, 'exact', '配置里确实有这个 key，不算回落')
  assert.deepEqual(info.args, [], '但传下去的是空的 —— 没有任何参数在约束成员')
  assert.equal(
    info.expressible, false,
    '★ 这是关键：配了 key 但值为空 ≠ 这一档生效了。界面上的"不改文件"是**空承诺**。'
  )
})

test('★★ describePermission：请求的档位没配 → 明说回落到了哪一档，而不是假装就是它', () => {
  // 造一个只配了 plan 与 execute 的成员 —— CLI 新版本刚支持一个新档位时的常见形态
  const spec = {
    defaultPermission: 'plan',
    permissionArgs: { plan: ['--plan'], execute: ['--write'] },
  }
  const info = describePermission(spec, 'readonly')
  assert.equal(info.source, 'fallback')
  assert.equal(info.effectiveLevel, 'plan', '实际跑的是 plan 档 —— 必须能被看出来')
  assert.deepEqual(info.args, ['--plan'], '参数确实来自默认档（这不是 bug，是事实）')
  assert.equal(info.expressible, false, '但它代表不了用户要的 readonly')
})

test('★ describePermission：连默认档都没配 → source 是 none，什么都不传', () => {
  const info = describePermission({ defaultPermission: 'plan' }, 'execute')
  assert.equal(info.source, 'none')
  assert.equal(info.effectiveLevel, null)
  assert.deepEqual(info.args, [])
  assert.equal(info.expressible, false)
})

test('★ describePermission：完全没配置（undefined spec）→ 不许抛异常', () => {
  for (const lv of PERMISSION_LEVELS) {
    const info = describePermission(undefined, lv)
    assert.equal(info.source, 'none')
    assert.deepEqual(info.args, [])
  }
})

test('★★ 一致性：adapter.permissionArgs(level) 必须与 describePermission().args 完全一致', () => {
  /*
   * 翻译逻辑曾经在 claude.js 与 generic.js 各写一份（同一句话抄两遍）。
   * 现在共用 base.js 的实现，这条断言就是"不许再分叉"的哨兵 ——
   * 两个出口漂移过一次（报告侧修了、CLI 侧没修），这仓库为那类问题付过学费。
   */
  for (const a of reg.list()) {
    if (typeof a.permissionArgs !== 'function') continue
    for (const lv of PERMISSION_LEVELS) {
      assert.deepEqual(
        a.permissionArgs(lv),
        describePermission(a.spec, lv).args,
        `${a.id} / ${lv}：两个出口给的参数必须一样`
      )
    }
  }
})

// ─────────────────────────── isWriteCapable：不知道就往贵的那边保守

test('★ isWriteCapable：显式声明优先于能力标签推断', () => {
  assert.equal(isWriteCapable({ capabilities: ['code'], writeCapable: false }), false)
  assert.equal(isWriteCapable({ capabilities: ['doc'], writeCapable: true }), true)
})

test('★ isWriteCapable：能力清单里没有写类能力（豆包的 ["doc"]）→ 不能写', () => {
  assert.equal(isWriteCapable({ capabilities: ['doc'] }), false)
})

test('★★ isWriteCapable：能力清单缺失 / 为空 = 不知道 → **按可能写处理**', () => {
  /*
   * 方向不能选错。判 false 会让引擎跳过文件改动采集，成员真写了文件也没人知道，
   * 而判定层因为拿不到数据（null）而永远不判 —— 静默失效，比误报更糟。
   * 判 true 最多多跑一趟目录快照。代价不对称，就往贵的那边保守。
   */
  assert.equal(isWriteCapable({}), true, '整个 spec 都没给')
  assert.equal(isWriteCapable(undefined), true, '连 spec 都没有')
  assert.equal(isWriteCapable({ capabilities: [] }), true, '空数组 = 没说明')
  assert.equal(isWriteCapable({ capabilities: 'code' }), true, '不是数组也算没说明')
})

// ─────────────────────────── memberMayWrite：采集与定罪共用的那一个判据

test('★★ memberMayWrite：claude 的只读档 → false（真有参数在约束它，不必白采）', () => {
  assert.equal(memberMayWrite(specOf('claude'), 'readonly'), false)
  assert.equal(memberMayWrite(specOf('cursor'), 'readonly'), false)
  assert.equal(memberMayWrite(specOf('qoder'), 'readonly'), false)
})

test('★★ memberMayWrite：trae 的只读档 → true（档位塌缩，承诺是空的，必须照样采集）', () => {
  const spec = specOf('trae')
  // 先确认前提还成立：只读与计划传的参数一模一样
  assert.deepEqual(
    describePermission(spec, 'readonly').args,
    describePermission(spec, 'plan').args,
    '前提变了：trae 现在能区分只读与计划了 —— 这条断言该更新了'
  )
  assert.equal(
    memberMayWrite(spec, 'readonly'), true,
    '★ 用户以为选了只读，但没有任何参数在约束它 —— 保守起见必须采集，否则真改了也没人知道'
  )
})

test('★★ memberMayWrite：豆包选写档 → false（REST 成员没有文件系统能力）', () => {
  /*
   * 这条是**误报**的直接来源：老写法在 execute 档下会照做目录快照，
   * 采集恒为空数组，而空数组在判定层的意思是"采集过、确实没改" →
   * 豆包产出里写一句"已创建文档"就被判可疑。拿量不到东西的尺子定罪。
   */
  assert.equal(memberMayWrite(specOf('doubao'), 'execute'), false)
  assert.equal(memberMayWrite(specOf('doubao'), 'full'), false)
  assert.equal(memberMayWrite(specOf('doubao'), 'readonly'), false)
})

test('★★ memberMayWrite：dsh 只读/计划档 → false（权限走环境变量，是真在约束它）', () => {
  /*
   * 上一版这条断言写的是反的：那时看到 dsh 的 `permissionArgs` 四档全 `[]`，
   * 就得出"权限无法表达 → 任何档位都按可能写处理"。
   *
   * 2026-09-29 实测推翻了它：dsh 的权限**不在命令行参数里**，在环境变量里。
   * `dsh --profile headless --help` 只有 `-h`，但 `DSH_PERMISSION_MODE` 一改，
   * 沙箱模式与审批策略跟着变（`--dump-config` 里写得明明白白）。实测：
   *
   *   DSH_PERMISSION_MODE=read-only + 「创建文件」→ 文件确实没被创建，
   *   dsh 自己报 `[sandbox: file access denied under read-only mode]`。
   *
   * 所以只读档现在**真的在拦**，引擎不需要白跑一趟目录快照。
   *
   * **教训：下"这个成员表达不了这一档"的结论之前，参数和环境变量都得查。**
   * 只查一个地方就说"不能生效"，和编造一个不存在的承诺，是同一种错。
   */
  assert.equal(memberMayWrite(specOf('dsh'), 'readonly'), false)
  assert.equal(memberMayWrite(specOf('dsh'), 'plan'), false)
  // 写档当然还是 true（可能改文件，必须采集）
  assert.equal(memberMayWrite(specOf('dsh'), 'execute'), true)
  assert.equal(memberMayWrite(specOf('dsh'), 'full'), true)
})

test('★★ dsh：四档都能表达 —— 走环境变量而不是参数', () => {
  for (const lv of PERMISSION_LEVELS) {
    const info = describePermission(specOf('dsh'), lv)
    assert.equal(info.source, 'exact', `dsh / ${lv} 应当有专属配置`)
    assert.equal(info.expressible, true, `dsh / ${lv} 应当能表达`)
    assert.deepEqual(info.args, [], `dsh / ${lv} 命令行上一个权限参数都没有`)
    assert.ok(
      Object.keys(info.env).length > 0,
      `dsh / ${lv} 必须靠环境变量表达 —— 否则这条断言就是空转`,
    )
  }

  /*
   * ⚠️ 这里**故意不去断言"四档环境变量互不相同"** —— dsh 的 readonly 与 plan
   * 本来就是同一个沙箱档（`read-only`），四档实际是**三组**。
   *
   * 但那是**合理**的塌缩，和 trae 那种"参数为空、承诺落空"的塌缩不是一回事：
   * 计划档的语义就是"只把方案想清楚、不动手"，用只读沙箱正是它该有的样子。
   * 断言"必须四组不同"会逼着实现去编一个假区别来讨好测试。
   *
   * 所以真正要钉的是**方向**：写档决不许落在只读沙箱里。
   * 塌缩本身不可怕，**塌到危险的那边**才可怕。
   */
  const sandboxOf = (lv) => describePermission(specOf('dsh'), lv).env.DSH_PERMISSION_MODE
  assert.equal(sandboxOf('readonly'), 'read-only')
  assert.equal(sandboxOf('plan'), 'read-only')
  assert.equal(sandboxOf('execute'), 'workspace-write')
  assert.equal(sandboxOf('full'), 'danger-full-access')

  for (const lv of ['execute', 'full']) {
    assert.notEqual(sandboxOf(lv), 'read-only', `写档 ${lv} 竟然落在只读沙箱里`)
  }
  // 写档与只读档必须真的不一样 —— 两组以内就是真塌缩了，得有人来看一眼
  const groups = new Set(PERMISSION_LEVELS.map(sandboxOf))
  assert.ok(groups.size >= 3, `四档只塌缩成 ${groups.size} 组，写档和只读档混在一起了`)
})

test('★★★ 环境变量**不参与档位回落** —— 授权只许往窄的方向给', () => {
  /*
   * 参数回落是"拿默认档的参数顶上"，界面会警告；这在参数上还能接受，
   * 因为参数只是"请求长什么样"。
   *
   * 环境变量是**授权**。把 B 档的授权拿去顶 A 档，方向正好是危险的那边：
   * 用户点「只读」，却拿到了执行档的写权限，而界面上还写着"只读"。
   * 所以这里的规矩是：环境变量只认"这一档有专属配置"，绝不回落。
   */
  const spec = {
    defaultPermission: 'execute',
    permissionArgs: { execute: ['--allow-write'] },
    permissionEnv: { execute: { DSH_PERMISSION_MODE: 'workspace-write' } },
  }
  const info = describePermission(spec, 'readonly')
  assert.equal(info.source, 'fallback')
  assert.deepEqual(info.args, ['--allow-write'], '参数仍然回落（这是既有行为）')
  assert.deepEqual(info.env, {}, '但是**环境变量一个都不许带过来**')
  assert.equal(info.expressible, false)
})

test('★★★ 环境变量真的到达了子进程 —— 不是只在配置里躺着', async () => {
  /*
   * 前面几条都是纯函数断言：它们只能证明"配置被读懂了"，
   * **证明不了 spawn 的时候真的把它传下去了**。中间隔着
   * describePermission → permissionEnv() → generic.run() → execMember() → spawn
   * 五道手，任何一道漏了，配置就是一张写着字的纸。
   *
   * 这里用假成员真跑一次进程（零 API 费用）：让子进程把自己看到的环境变量打出来。
   * 哨兵值 'SENTINEL-PERM-LEVEL' 是本轮新增代码才可能产出的 —— 老代码不可能返回它。
   */
  const spec = {
    id: 'env-probe',
    name: 'env-probe',
    adapter: 'generic',
    command: process.execPath,
    promptMode: 'stdin',
    argsTemplate: ['-e', "process.stdout.write(String(process.env.PROBE_LEVEL))"],
    defaultPermission: 'plan',
    capabilities: ['code'],
    permissionArgs: { plan: [], execute: [], full: [], readonly: [] },
    permissionEnv: { execute: { PROBE_LEVEL: 'SENTINEL-PERM-LEVEL' } },
  }
  const a = new GenericAdapter(spec)
  const r = await a.run({ prompt: '', permission: 'execute', timeoutMs: 20000 })
  assert.match(
    String(r.raw?.stdout ?? ''), /SENTINEL-PERM-LEVEL/,
    '环境变量没走到子进程 —— permissionEnv 这条链路中间断了',
  )

  // 反向对照：只读档没配环境变量 → 子进程看到的必须是空的（不是把上一档的带过去）
  const r2 = await a.run({ prompt: '', permission: 'readonly', timeoutMs: 20000 })
  assert.doesNotMatch(
    String(r2.raw?.stdout ?? ''), /SENTINEL-PERM-LEVEL/,
    '只读档竟然拿到了执行档的环境变量 —— 这正是"授权往宽的方向顶"',
  )
})

test('★ memberMayWrite：写档对任何有写能力的成员都是 true', () => {
  for (const id of ['claude', 'cursor', 'qoder', 'trae']) {
    for (const lv of ['execute', 'full']) {
      assert.equal(memberMayWrite(specOf(id), lv), true, `${id} / ${lv}`)
    }
  }
})

test('★ memberMayWrite 与 WRITE_PERMISSIONS 同源：写档的集合只定义在一处', () => {
  assert.deepEqual([...WRITE_PERMISSIONS].sort(), ['execute', 'full'])
})

// ─────────────────────────── 全配置矩阵：把现状打印出来，便于人工核对

test('★ 真实配置矩阵：每个成员每档的「翻译结果 / 是否真的生效」', () => {
  const rows = []
  for (const a of reg.list()) {
    for (const lv of PERMISSION_LEVELS) {
      const info = describePermission(a.spec, lv)
      rows.push({
        member: a.id,
        level: lv,
        args: JSON.stringify(info.args),
        source: info.source,
        expressible: info.expressible,
        mayWrite: memberMayWrite(a.spec, lv),
      })
    }
  }
  // 至少要有真实配置在跑 —— 空集合上的断言等于没写
  assert.ok(rows.length >= 20, `矩阵只有 ${rows.length} 行，显然没读到真实配置`)
  assert.ok(rows.some((r) => !r.expressible), '当前配置里应当存在"档位无法表达"的成员')
  assert.ok(rows.some((r) => r.expressible), '当前配置里也应当存在"档位真的生效"的成员')

  // 塌缩检测：同一成员内，多个档位传下去的参数完全相同
  const collapsed = []
  for (const a of reg.list()) {
    const groups = new Map()
    for (const lv of PERMISSION_LEVELS) {
      const key = JSON.stringify(describePermission(a.spec, lv).args)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(lv)
    }
    for (const [key, lvs] of groups) {
      if (lvs.length > 1) collapsed.push(`${a.id}: ${key} ← ${lvs.join('/')}`)
    }
  }
  // 这不是"必须有"的断言，而是"如果有，必须被这份清单说出来"的提醒
  assert.ok(collapsed.length >= 0)
  if (collapsed.length) {
    console.log('  ⚠️ 档位塌缩（这些档位用户区分不出来）：\n    ' + collapsed.join('\n    '))
  }
})
