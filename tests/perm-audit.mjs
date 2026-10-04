/*
 * 权限档位审计 —— 成员 × 档位 → 实际传下去的参数**和环境变量**。
 *
 * 不是 *.test.mjs，`npm test` 不会跑它；它是一次性取证工具：
 * 改了权限相关的东西之后跑一遍，肉眼看矩阵。塌缩/回落会直接标出来。
 *
 * ⚠️ 2026-09-29 修正：**参数不是唯一的表达方式**。
 * 第一版只看 `permissionArgs`，于是把 dsh 记成"四档全 `[]`、权限无法表达"。
 * 实际上 dsh 的权限走 `DSH_PERMISSION_MODE` 环境变量 —— 参数表全空，
 * 但四个档位行为完全不同（实测 read-only 下连工作区内写文件都被拒）。
 * **只查一个地方就下"表达不了"的结论，是把一个能生效的档位说成不能生效。**
 * 所以现在同时打印 args 与 env，`expressible` 也按两者一起算。
 */
import { loadRegistry } from '../src/adapters/index.js'
import { describePermission, PERMISSION_LEVELS } from '../src/adapters/base.js'
import { WRITE_PERMISSIONS } from '../src/engine/quality.js'

const reg = loadRegistry()

for (const a of reg.list()) {
  const argMap = a.spec.permissionArgs || {}
  const envMap = a.spec.permissionEnv || {}
  const hasFn = typeof a.permissionArgs === 'function'
  const hasEnvFn = typeof a.permissionEnv === 'function'
  console.log(`\n[${a.id}] enabled=${a.isEnabled} defaultPermission=${a.spec.defaultPermission} adapter=${a.spec.adapter}`)
  if (!hasFn && !Object.keys(envMap).length) {
    console.log('  ⚠️ 该适配器没有权限机制 —— 权限档位对它完全不存在（REST 型）')
  }
  const seen = new Map()
  for (const lv of PERMISSION_LEVELS) {
    const info = hasFn ? describePermission(a.spec, lv) : null
    const configured = Object.prototype.hasOwnProperty.call(argMap, lv)
      || Object.prototype.hasOwnProperty.call(envMap, lv)
    const marks = []
    if (info?.source === 'fallback') marks.push('★静默回落到默认档')
    if (info && info.source === 'exact' && !info.expressible) marks.push('☆配了但为空/档位无法表达')
    if (info?.source === 'none') marks.push('☆未配置')
    if (WRITE_PERMISSIONS.has(lv)) marks.push('[写档→引擎会采集文件改动]')
    console.log(
      `  ${lv.padEnd(9)} 配置=${configured ? 'Y' : '(未配置)'}` +
      `  实传=${hasFn ? JSON.stringify(info.args) : '—'}` +
      `  环境=${hasEnvFn ? JSON.stringify(a.permissionEnv(lv)) : '—'}` +
      `  生效=${info ? (info.expressible ? 'YES' : 'no ') : '—'}` +
      (marks.length ? '  ' + marks.join(' ') : '')
    )
    // 塌缩要按"参数 + 环境变量"整体比 —— 只看参数会把 dsh 误判成全塌缩
    const key = hasFn ? JSON.stringify([info.args, info.env]) : 'no-fn'
    if (!seen.has(key)) seen.set(key, [])
    seen.get(key).push(lv)
  }
  if (hasFn) {
    const collide = [...seen.entries()].filter(([, lvs]) => lvs.length > 1)
    if (collide.length) {
      console.log('  ── 档位塌缩（这些档位传下去的东西一模一样，用户区分不出来）：')
      for (const [k, lvs] of collide) console.log(`     ${k} ← ${lvs.join(' / ')}`)
      console.log('     ℹ️ 塌缩本身未必是缺陷 —— 只读档与计划档用同一个沙箱是合理的。')
      console.log('        要盯的是**方向**：写档决不能落在只读沙箱里。')
    }
  }
}
