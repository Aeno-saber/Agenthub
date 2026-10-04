/**
 * 子任务计划 —— 数据结构、校验、依赖分层
 *
 * 计划由主脑（WorkBuddy）产出，本模块负责把它验干净并算出执行顺序。
 */
import { PERMISSION_LEVELS } from '../adapters/base.js'

/**
 * @typedef {Object} Subtask
 * @property {string} id            唯一标识，如 "s1"
 * @property {string} memberId      派给谁
 * @property {string} [role]        角色标签，如 "代码主笔"
 * @property {string} prompt        给这个成员的指令
 * @property {string[]} [dependsOn] 依赖哪些子任务
 * @property {string} [permission]  覆盖全局的权限档位
 * @property {string} [title]       短标题，用于展示
 */

/** 校验计划合法性，尽量一次把所有问题报全 */
export function validatePlan(plan) {
  const errors = []
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['plan 不是对象'] }
  if (!plan.goal) errors.push('缺少 goal（任务目标）')

  const list = Array.isArray(plan.subtasks) ? plan.subtasks : []
  if (list.length === 0) errors.push('subtasks 为空')

  const ids = new Set()
  for (const st of list) {
    if (!st.id) { errors.push('存在子任务缺少 id'); continue }
    if (ids.has(st.id)) errors.push(`子任务 id 重复：${st.id}`)
    else ids.add(st.id)

    if (!st.memberId) errors.push(`子任务 ${st.id} 缺少 memberId`)
    if (!st.prompt) errors.push(`子任务 ${st.id} 缺少 prompt`)
    if (st.permission && !PERMISSION_LEVELS.includes(st.permission)) {
      errors.push(`子任务 ${st.id} 的 permission 非法：${st.permission}`)
    }
  }

  for (const st of list) {
    for (const dep of st.dependsOn || []) {
      if (dep === st.id) errors.push(`子任务 ${st.id} 依赖了自己`)
      else if (!ids.has(dep)) errors.push(`子任务 ${st.id} 依赖了不存在的 ${dep}`)
    }
  }

  const cyc = findCycle(list)
  if (cyc) errors.push(`依赖成环：${cyc.join(' → ')}`)

  return { ok: errors.length === 0, errors }
}

/** 找依赖环，返回环上 id 序列；无环返回 null */
export function findCycle(subtasks) {
  const deps = new Map(subtasks.map((s) => [s.id, s.dependsOn || []]))
  const state = new Map()
  const stack = []
  let found = null

  const visit = (id) => {
    if (found) return
    const s = state.get(id) || 0
    if (s === 1) {
      found = stack.slice(stack.indexOf(id)).concat(id)
      return
    }
    if (s === 2) return
    state.set(id, 1)
    stack.push(id)
    for (const d of deps.get(id) || []) visit(d)
    stack.pop()
    state.set(id, 2)
  }

  for (const st of subtasks) visit(st.id)
  return found
}

/**
 * 按依赖分层。同一层内互不依赖，可以并行跑。
 * @returns {Subtask[][]}
 */
export function layers(subtasks) {
  const deps = new Map(subtasks.map((s) => [s.id, new Set(s.dependsOn || [])]))
  const done = new Set()
  const remaining = new Set(subtasks.map((s) => s.id))
  const out = []
  let guard = 0

  while (remaining.size > 0 && guard++ < 1000) {
    const ready = [...remaining].filter((id) =>
      [...(deps.get(id) || [])].every((d) => done.has(d))
    )
    if (ready.length === 0) break
    out.push(ready.map((id) => subtasks.find((s) => s.id === id)))
    for (const id of ready) { done.add(id); remaining.delete(id) }
  }

  return out
}

/** 生成一份计划的文字预览，用于"执行计划确认"环节 */
export function describePlan(plan) {
  const ls = layers(plan.subtasks || [])
  const lines = [`目标：${plan.goal}`, `共 ${plan.subtasks?.length || 0} 个子任务，分 ${ls.length} 批执行`, '']
  for (const [i, layer] of ls.entries()) {
    lines.push(`第 ${i + 1} 批${layer.length > 1 ? '（可并行）' : ''}：`)
    for (const st of layer) {
      const dep = (st.dependsOn || []).length ? ` ← 依赖 ${st.dependsOn.join('、')}` : ''
      lines.push(`  · [${st.id}] ${st.memberId} / ${st.role || '执行者'} — ${st.title || st.prompt.slice(0, 40)}${dep}`)
    }
  }
  return lines.join('\n')
}
