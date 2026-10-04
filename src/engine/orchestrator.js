/**
 * 编排引擎 —— 主从编排的执行体
 *
 *  计划（主脑产出） → 校验 → 分层 → 逐层执行（层内并行） → 收集 → 轨迹
 */
import { validatePlan, layers, describePlan } from './plan.js'
import { Trace } from './trace.js'
import { judgeOutput, memberMayWrite } from './quality.js'
import { snapshotTree, collectChanges } from './changes.js'
import { elide } from '../util/text.js'
import process from 'node:process'

const DEFAULT_OPTIONS = {
  permission: 'plan',
  timeoutMs: 600000,
  subtaskBudgetUsd: null,   // 单个子任务的美元上限
  totalBudgetUsd: null,     // 整个任务的美元上限
  upstreamExcerptChars: 4000,
  onFailure: 'skip-blocked',  // 失败策略，见 FAILURE_POLICIES
  trackChanges: true,       // 写权限档下采集文件改动（让 claimed-edit-no-change 有数据可用）
}

/**
 * 一个子任务失败之后，剩下的活怎么办。
 *
 * 起因（2026-09-29 真跑，见 docs/05 第九节）：4 个子任务，s1/s2 成功、s3 失败、
 * s4 是**最终交付**。原来的实现是布尔开关 `stopOnFailure: true` ——
 * s3 一失败就把后面所有批次整单停掉，于是 s4 永不执行，
 * s1+s2 花掉的真金白银只换到两份中间产物。**省钱的设计反而烧钱。**
 *
 * 所以这里换成三个有语义的策略，而不是一个布尔：
 *
 *  - `abort`        —— 任一批有失败，停止后续所有执行。最省，但可能白花。
 *  - `skip-blocked` —— **只跳过真正被断链的**（默认）。不依赖失败结果的分支照跑完，
 *                      因为它们的前提并没被破坏；被跳过的每一条都写进报告，说明为什么。
 *  - `salvage`      —— 谁都不跳。依赖断了也照样把下游放出去跑，
 *                      但**必须**把"缺了谁"明确写进下游的 prompt 和报告里
 *                      （见 buildPrompt 的缺口段落与 entry.degradedUpstream）。
 *                      想要"哪怕有洞也要那份最终交付"时用它。
 *
 * 三个策略都不允许出现"无声地少跑几条"：无论走哪条路，
 * 每个子任务最终都会在轨迹里有一格（成功 / 失败 / 未执行）。
 */
export const FAILURE_POLICIES = ['abort', 'skip-blocked', 'salvage']
const DEFAULT_FAILURE_POLICY = 'skip-blocked'

/**
 * 解析失败策略，并兼容旧的布尔开关 `stopOnFailure`。
 *
 *  `true`  → `abort`（旧语义：失败即停）
 *  `false` → `salvage`（旧语义：谁都不停）
 *
 * 注意旧代码里 `stopOnFailure: false` 其实等价于"**带洞静默继续**"——
 * 依赖缺失时 buildPrompt 会把那段上游整块跳过，下游根本不知道自己少了一份输入。
 * 映射到 `salvage` 后，缺口会被明说 —— 这是这条兼容规则里唯一的行为变化，且是往好里变。
 */
export function resolveFailurePolicy(options = {}) {
  if (options.onFailure != null) {
    if (!FAILURE_POLICIES.includes(options.onFailure)) {
      throw new Error(
        `未知的失败策略 onFailure=${options.onFailure}，可选：${FAILURE_POLICIES.join(' / ')}`
      )
    }
    return options.onFailure
  }
  if (options.stopOnFailure === true) return 'abort'
  if (options.stopOnFailure === false) return 'salvage'
  return DEFAULT_FAILURE_POLICY
}

/**
 * 一个子任务的依赖里，有哪些没能提供**可用**产出。
 *
 * 「结果不存在」和「结果存在但状态不是 ok」在这里必须算同一种东西 ——
 * 对下游来说，拿到的东西是一样的：没有。分两种写法迟早会漏掉一种。
 *
 * `how` 取值：
 *  - `missing`     结果压根不存在（还没轮到他，或数据丢了）
 *  - `failed`      调用了成员但没干成
 *  - `skipped`     被引擎的策略跳过（依赖断链 / 预算上限 / 整单中止）
 *  - `user-skip`   用户点了「跳过」—— 明确拍板这一步的产出**不要了**
 *
 * ⚠️ `user-skip` 必须和 `skipped` 分开：前者是**用户的决定**，
 * 意味着"这一步不是必须的"，它不该再卡住下游；后者是引擎的策略行为，含义相反。
 * 把两者合并，就等于让一次点击偷偷改写了失败策略的语义。
 */
export function brokenDeps(st, ctx) {
  const out = []
  for (const id of st.dependsOn || []) {
    const r = ctx.results?.[id]
    if (!r) out.push({ id, how: 'missing' })
    else if (r.status !== 'ok') {
      out.push({ id, how: r.status === 'skipped' && r.skipKind === 'user' ? 'user-skip' : r.status })
    }
  }
  return out
}

/** 依赖里**会卡住下游**的那些 —— 用户已拍板不要的不算 */
export const blockingDeps = (st, ctx) => brokenDeps(st, ctx).filter((b) => b.how !== 'user-skip')

/*
 * 上游产出超长时要截断（不然下游 prompt 会爆），但**必须保留头尾**。
 *
 * 原来是 `s.slice(0, n)` —— 只留开头。
 * 实测（2026-09-29 真跑）：上游 claude 交了一份 7392 字符的规则盘点报告，
 * 而默认上限是 4000 字符，{@link truncate} 会把后 3392 字符整段扔掉，
 * 而那份报告的**结论和结构性缺口清单恰恰在后面**。
 * 只截头等于让下游"看了半份报告还以为看完了"，比不传更危险。
 */
const truncate = (s, n) =>
  !s ? '' : s.length > n ? elide(s, n) + `\n…（上游产出过长，已按头尾保留截断，原文 ${s.length} 字符）` : s

/** 组装子任务的完整 prompt —— 上下文传递就发生在这里 */
export function buildPrompt(st, ctx, options) {
  const parts = []
  parts.push(`【任务总目标】\n${ctx.plan.goal}`)
  parts.push(`【本次子任务】\n${st.prompt}`)
  if (st.role) parts.push(`【你的角色】${st.role}`)

  const upIds = st.dependsOn || []
  const blocks = []
  const gaps = []
  for (const id of upIds) {
    const up = ctx.results[id]
    /*
     * ★ 依赖没有可用产出时，必须**明说**，不能像原来那样 `continue` 掉。
     *
     * 旧写法是 `if (!up) continue` —— 那段上游在 prompt 里凭空消失，从下游的视角看
     * "我依赖的东西本来就不存在"，它照样会交出一份看起来完整、实则少了一块输入的结论。
     * 这就是「上游信号被丢掉」这个错在 prompt 拼装层的同一副面孔：
     * 前面刚在 changes.js / quality.js / trace.js 各修过一遍。
     *
     * 严格的判定标准：**只有 `status === 'ok'` 才算可用产出**。
     * 真实 entry 一定带 status（runOne / markSkipped 都会写），
     * 所以"没有 status"也按缺口处理 —— 宁可对下游多说一句，
     * 也不放一个状态不明的上游混进上下文。
     */
    if (!up) {
      gaps.push(`- 子任务 ${id}：**没有产出**（未执行或结果缺失）`)
      continue
    }
    if (up.status !== 'ok') {
      const why = String(up.text || '').split('\n')[0].slice(0, 200)
      /*
       * 「被用户主动跳过」和「执行失败」对下游的含义不同，措辞不能混：
       * 前者是"这一步确认不做"，后者是"这一步想做成但没成"。
       * 下游据此判断"这块内容是本来就不该有，还是本该有却缺失"，从而决定要不要留出余地。
       */
      const how = up.status !== 'skipped' ? '执行失败'
        : (up.skipKind === 'user' ? '被用户主动跳过（确认不要这一步的产出）' : '被跳过')
      gaps.push(`- 子任务 ${id}：**${how}**${why ? ` —— ${why}` : ''}`)
      continue
    }
    blocks.push(
      `—— 来自子任务 ${id}（${up.memberName || up.memberId} / ${up.role || '执行者'}）——\n` +
      truncate(up.text, options.upstreamExcerptChars)
    )
  }
  if (blocks.length) parts.push(`【上游产出，请基于它继续】\n${blocks.join('\n\n')}`)
  if (gaps.length) {
    parts.push(
      `【⚠️ 上游有缺口，你的结论必须带上这个前提】\n${gaps.join('\n')}\n` +
      '上面这些子任务没有给你可用输入。请在缺它们的情况下尽力完成本次任务，' +
      '并在结论开头用一句话写明：缺了哪一项、因此哪些结论不完整或未经核实。' +
      '**不要假装它们的结果存在。**'
    )
  }

  parts.push('【要求】直接产出结果，不要复述上面的说明文字。')
  return parts.join('\n\n')
}

export class Orchestrator {
  constructor(registry, options = {}) {
    this.registry = registry
    this.options = { ...DEFAULT_OPTIONS, ...options }
    // 兼容旧的布尔 `stopOnFailure`；解析结果同时写回 options，方便下游读取
    this.policy = resolveFailurePolicy(options)
    this.options.onFailure = this.policy
  }

  /** 子任务在轨迹里的公共字段 —— runOne 和 markSkipped 共用，避免两处写法漂移 */
  baseFor(st) {
    const adapter = this.registry.get(st.memberId)
    return {
      id: st.id,
      title: st.title || '',
      memberId: st.memberId,
      memberName: adapter?.name || st.memberId,
      role: st.role || '',
      permission: st.permission || this.options.permission,
      dependsOn: st.dependsOn || [],
    }
  }

  /**
   * 记一条「没执行」的子任务。
   *
   * `status: 'skipped'` 是**第三种**状态：既不是成功，也不是失败。
   *  - 混进 failed 里 → 报告会说"3 个失败"，可实际上一个成员都没被调用、一分钱没花；
   *  - 干脆不记     → 报告里这几条整段消失，用户以为计划本来就只有这么多步。
   * 两种都是假的，所以它必须占自己的一格。
   *
   * `kind` 把三种"没执行"分开存：`blocked`（依赖断链）/ `aborted`（策略中止整单）/
   * `budget`（预算上限）。处置方式不一样，所以数据层先分清，报告想拆就能拆。
   */
  markSkipped(st, ctx, trace, onEvent, reason, kind = 'blocked') {
    const entry = trace.upsert({
      ...this.baseFor(st),
      status: 'skipped',
      skipKind: kind,
      text: reason,
      prompt: st.prompt || '',
      cost: {},
      durationMs: 0,
      raw: {},
    })
    // 也放进 results：下游算"断链"时才会把被跳过的上游算成断的
    ctx.results[st.id] = entry
    onEvent({ type: 'subtask-skip', ...entry })
    return entry
  }

  /** 干跑：只校验与排版，不执行任何成员调用 */
  dryRun(plan) {
    const v = validatePlan(plan)
    if (!v.ok) return { ok: false, errors: v.errors }
    return {
      ok: true,
      preview: describePlan(plan),
      batches: layers(plan.subtasks).map((l) => l.map((s) => s.id)),
    }
  }

  /**
   * 执行一个计划
   * @param {object} plan
   * @param {object} opts
   * @param {(evt:object)=>void} [opts.onEvent] 进度事件（给日志/界面用）
   * @param {string} [opts.workdir]
   * @returns {Promise<{trace:Trace, ctx:object}>}
   */
  async run(plan, { onEvent = () => {}, workdir } = {}) {
    const v = validatePlan(plan)
    if (!v.ok) {
      throw new Error('计划非法，拒绝执行：\n' + v.errors.map((e) => '  - ' + e).join('\n'))
    }

    const trace = new Trace(plan.goal)
    const ctx = {
      plan,
      results: {},
      spentUsd: 0,
      workdir: workdir || process.cwd(),
      aborted: false,
      abortReason: '',
      policy: this.policy,
    }

    onEvent({ type: 'plan-start', goal: plan.goal, preview: describePlan(plan), policy: this.policy })

    await this.advance(plan, ctx, trace, onEvent, { reason: 'initial' })

    /*
     * ★ 收尾这两行**首跑和续跑都必须有**。
     *
     * 2026-09-29 抽 `advance()` 时，它们被一起搬进了 `resume()`，`run()` 路径上就再也没了 ——
     * 后果是整单跑完之后：
     *   - `finishedAt` 恒为 null、`durationMs` 恒为初始值 0 → 报告印「总耗时 0.0s」（假数字）
     *   - `plan-finish` 事件永不发出 → 命令行的完成汇总行、界面的"全部结束：…"都不触发
     * 而且**没有任何断言覆盖它**，所以它安静地退化了两轮。
     * 现在 trace.js 的 `durationCell()` 会把"未收尾"显式印出来，
     * orchestrator.test.mjs 也补了断言 —— 下次再被搬走，立刻变红。
     */
    trace.finish()
    onEvent({ type: 'plan-finish', summary: trace.summary, reason: 'initial' })
    return { trace, ctx }
  }

  /**
   * 推进一遍计划：按层逐层跑，层内并行。
   *
   * `run()`（整单首跑）和 `resume()`（单卡片重试之后的接着跑）**共用这一份逻辑**。
   * 分成两份写迟早会漂移 —— 那正是这个仓库里反复踩过的坑
   * （`WRITE_PERMISSIONS` 定义在两处就会"采集了但判定不认"）。
   *
   * @param {'initial'|'resume'} reason  首跑还是续跑。只影响事件文案与「谁该重跑」的判定
   * @param {?string} onlyId  续跑时用户点名的那个子任务 —— 只有它允许重跑已失败的活
   */
  async advance(plan, ctx, trace, onEvent, { reason = 'initial', onlyId = null } = {}) {
    const batches = layers(plan.subtasks)
    for (const [i, batch] of batches.entries()) {
      if (ctx.aborted) break

      const pending = batch.filter((st) => this.needsRun(st, ctx, reason, onlyId))
      if (!pending.length) continue   // 这一层全都跑过了

      onEvent({
        type: 'batch-start',
        index: i + 1,
        total: batches.length,
        ids: pending.map((s) => s.id),
        parallel: pending.length > 1,
        reason,
      })

      const runnable = []
      for (const st of pending) {
        const broken = blockingDeps(st, ctx)
        // 没有卡住下游的断链，或者策略是"带洞也跑" → 照常执行
        if (!broken.length || this.policy === 'salvage') { runnable.push(st); continue }
        /*
         * 只跳过**真正被断链**的那一条，不牵连别人。
         *
         * 断链的影响范围就是依赖它的那几条；同一层和后续层里不依赖失败结果的子任务，
         * 它们的前提并没有被破坏，产出依然是有效的 —— 一起停掉等于把已经具备的条件白白作废。
         */
        this.markSkipped(st, ctx, trace, onEvent,
          `未执行：依赖的 ${broken.map((b) => b.id).join('、')} 没有可用产出`, 'blocked')
      }

      // 同层并行
      const settled = await Promise.all(
        runnable.map((st) => this.runOne(st, ctx, trace, onEvent))
      )

      const failed = settled.filter((r) => r.status !== 'ok')
      if (failed.length && this.policy === 'abort') {
        ctx.aborted = true
        ctx.abortReason = `第 ${i + 1} 批有 ${failed.length} 个子任务失败（${failed.map((r) => r.id).join('、')}）`
        onEvent({
          type: 'aborted',
          reason: `${ctx.abortReason}，按策略「中止整单」停止后续执行`,
          failedIds: failed.map((r) => r.id),
        })
      }
    }

    /*
     * 收尾：**没跑到的子任务也要各留一条记录**。
     *
     * 原来这里是 `break` 出去就完事 —— 后面几条连一条轨迹都没有，在报告里整段消失，
     * 用户只看到一句"按策略停止后续执行"：既不知道跳了谁，也不知道还剩什么是能用的。
     * 这种"无声的消失"和 changes.js / quality.js / trace.js 里修的是同一类问题，
     * 只不过它发生在编排层的控制流上。
     */
    for (const st of plan.subtasks) {
      if (ctx.results[st.id]) continue
      const broken = brokenDeps(st, ctx)
      this.markSkipped(st, ctx, trace, onEvent,
        ctx.aborted
          ? `未执行：${ctx.abortReason}，失败策略为「中止整单」`
          : `未执行：依赖的 ${broken.map((b) => b.id).join('、')} 没有可用产出`,
        ctx.aborted ? 'aborted' : 'blocked')
    }
  }

  /**
   * 这一步现在该不该跑？
   *
   * ★ 这里划的是**花钱的边界**，是整个"单卡片重跑"里最要紧的一段判断：
   *
   *  - 已 `ok` 的 —— **绝不重跑**。整单重跑一次要多花一遍钱，
   *    而重试功能存在的理由恰恰是"别重复花已经花过的钱"。
   *  - 已 `failed` 的 —— 只重跑**用户点名的那一个**。重试一件已经失败过的活
   *    是一笔新的开销，必须是人的明确决定，不能由"顺便"发生。
   *  - 被 `skipped` 的 —— 重新评估。它一分钱没花过，重评估是免费的，
   *    而这正是重试的收益所在：卡住它的那一步修好之后，这些步骤应该自己跑起来。
   *  - 被**用户**跳过的 —— 不重跑。那是人的最终决定，续跑不该替他把这一步翻案。
   */
  needsRun(st, ctx, reason, onlyId) {
    if (reason === 'initial') return true
    const cur = ctx.results[st.id]
    if (!cur) return true
    if (cur.status === 'ok') return false
    // ★ 用户拍板放弃的步骤，任何"接着跑"都不许把它重新拉起来
    if (cur.status === 'skipped' && cur.skipKind === 'user') return false
    if (cur.status === 'skipped') return true
    return st.id === onlyId   // failed：只有点名的那个才重跑
  }

  /**
   * 接着跑：用**同一次运行的现场**（ctx + trace），把还没成功的步骤推进下去。
   *
   * 为什么要它：一次真跑里某一步挂了，原来只能整单重跑 —— 已经成功的那几步
   * 会**再花一遍钱**。有了现场就能只补没成的那部分。
   *
   * 前提是调用方拿着真正的现场。找不到现场时必须**明说找不到**，
   * 绝不能退化成"那就整单重跑吧" —— 那是在用户没同意的情况下花钱。
   */
  async resume(plan, { ctx, trace, onEvent = () => {}, onlyId = null } = {}) {
    if (!ctx || !trace) throw new Error('续跑需要同一次运行的现场（ctx + trace），没有就请整单重跑')

    onEvent({
      type: 'resume-start',
      goal: plan.goal,
      onlyId,
      previous: trace.summary,
    })

    // 用户既然明确要求"接着跑"，上一次的中止状态就不该继续压着后面
    ctx.aborted = false
    ctx.abortReason = ''

    await this.advance(plan, ctx, trace, onEvent, { reason: 'resume', onlyId })

    trace.finish()
    onEvent({ type: 'plan-finish', summary: trace.summary, reason: 'resume' })
    return { trace, ctx }
  }

  /**
   * 重试/换人某一步，然后接着往下跑。
   *
   * 换人 = 把计划里这一步的 `memberId` 改掉。**改的是计划本身**，
   * 因为后续报告、"再跑一遍"都得以新成员为准 —— 只在这一次调用里临时换掉，
   * 报告上写着旧成员、实际是新成员干的，又是一处对不上。
   */
  async retrySubtask(plan, { ctx, trace, onEvent = () => {}, id, memberId } = {}) {
    const st = (plan.subtasks || []).find((s) => s.id === id)
    if (!st) throw new Error(`计划里没有子任务 ${id}`)

    const before = st.memberId
    if (memberId && memberId !== before) {
      st.memberId = memberId
      // 成员换了，之前那条结果的归属也要跟着变，否则报告里会张冠李戴
      if (ctx?.results?.[id]) ctx.results[id].memberId = memberId
      onEvent({ type: 'subtask-member-changed', id, from: before, to: memberId })
    }

    return this.resume(plan, { ctx, trace, onEvent, onlyId: id })
  }

  /**
   * 用户主动放弃某一步。
   *
   * 和"被策略跳过"不是一件事，所以记成 `skipKind: 'user'`：
   * 用户拍板的是"这一步的产出**不要了**"，也就是说它**不再是下游的必须前提** ——
   * 所以依赖它的步骤不该继续被它卡住，而应该带着"缺了它"的标记往下跑。
   * （引擎自己没资格做这个判断，用户才有。见 brokenDeps 的说明。）
   */
  async skipSubtask(plan, { ctx, trace, onEvent = () => {}, id } = {}) {
    const st = (plan.subtasks || []).find((s) => s.id === id)
    if (!st) throw new Error(`计划里没有子任务 ${id}`)

    const entry = this.markSkipped(st, ctx, trace, onEvent,
      `已由用户跳过：这一步的产出不要了，依赖它的步骤会带着缺口继续`, 'user')
    if (entry.status !== 'skipped' || entry.skipKind !== 'user') {
      // 防呆：markSkipped 的语义万一被改坏，这里要立刻炸，而不是悄悄按"策略跳过"往下走
      throw new Error(`跳过 ${id} 没有生效（得到 status=${entry.status} / skipKind=${entry.skipKind}）`)
    }
    return this.resume(plan, { ctx, trace, onEvent })
  }

  /** 执行单个子任务 */
  async runOne(st, ctx, trace, onEvent) {
    const adapter = this.registry.get(st.memberId)
    const base = this.baseFor(st)

    if (!adapter) {
      const entry = trace.upsert({ ...base, status: 'failed', text: `未知成员：${st.memberId}`, prompt: st.prompt, cost: {}, durationMs: 0, raw: {} })
      onEvent({ type: 'subtask-finish', ...entry })
      return entry
    }

    // 预算闸
    if (this.options.totalBudgetUsd != null && ctx.spentUsd >= this.options.totalBudgetUsd) {
      /*
       * 闸门拦下的是"**没执行**"，不是"失败了" —— 原来记成 `failed`，
       * 结果报告里"失败"这一栏把"引擎压根没调用成员"也算进去，
       * 而这两种情况的处置完全不同：失败要看产出、要重试；没执行只需要看预算。
       *
       * 判定口径统一成一句：**`skipped` = 引擎没有调用成员**，所以它没花钱、没产出。
       * 依赖断链、策略中止、预算上限，三条路都归到这里。
       */
      return this.markSkipped(st, ctx, trace, onEvent,
        `未执行：已触及总预算上限 $${this.options.totalBudgetUsd}（已花 $${ctx.spentUsd.toFixed(4)}` +
        `${ctx.unknownCostCount ? `，另有 ${ctx.unknownCostCount} 个子任务未上报美元成本、不在此数内` : ''}）`,
        'budget')
    }

    /*
     * 这次是在"上游有洞"的情况下执行的吗？
     *
     * 只有 `salvage` 策略下才可能为真（另两种策略会把断链的子任务直接跳过）。
     * 一旦为真，这条产出就是**不完整的** —— 它自己可能是 ok（成员确实好好干活了），
     * 但它的前提缺了一块。报告必须把这件事写出来，
     * 否则"半份成果"就会被包装成"完整成果"递到用户手里。
     */
    const degraded = brokenDeps(st, ctx).map((b) => b.id)

    const prompt = buildPrompt(st, ctx, this.options)
    // 带着缺口跑的时候，开始事件就把它带上 —— 界面不用等跑完才知道这次是"残局"
    onEvent({ type: 'subtask-start', ...base, degradedUpstream: degraded })

    /*
     * 跑之前先给工作目录拍一张快照 —— 只为在跑完之后回答一个问题：
     * 「这个成员到底有没有在磁盘上留下改动？」
     *
     * ★ 判据是 `memberMayWrite()`，**不是**「用户选的是不是写档」。
     * 这两者不总是一回事，实测差异见 quality.js 里的表：
     *  - 豆包是 REST 成员，**没有文件系统能力** → 永远采不到东西。
     *    老写法会照采，采到空 `[]`，而空数组在判定层的意思是"采集过、确实没改" →
     *    豆包产出里写一句"已创建文档"就被判可疑。**拿量不到东西的尺子定罪。**
     *  - trae 的只读档参数是 `[]`（与 plan 完全一样）→ 没有参数在约束它，
     *    界面上的"不改文件"是空承诺 → 必须照样采集，否则真改了也没人知道。
     *
     * 失败/超限时快照自带 `truncated` 标记 → 最终会被当作"未采集"（null），
     * **绝不退化成"零改动"** —— 那个区别是判定层定罪与否的分界。详见 changes.js。
     */
    const mayWrite = memberMayWrite(adapter.spec, base.permission)
    const willTrack = this.options.trackChanges !== false && mayWrite
    const beforeSnap = willTrack ? snapshotTree(ctx.workdir, this.options.snapshotLimits || {}) : null

    const r = await adapter.run({
      prompt,
      workdir: ctx.workdir,
      permission: base.permission,
      role: st.role,
      timeoutMs: this.options.timeoutMs,
      maxBudgetUsd: this.options.subtaskBudgetUsd,
      // 刻意**不传** model —— 2026-09-29 决策，不是漏写：
      // 让每个成员沿用各自 CLI 的既有配置（claude 就跟随 CC Switch / settings.json），
      // 这样换供应商时只改一处，不必在 AgentHub 里再维护一份模型清单。
      // 将来若要给某个成员固定模型，在这里加 `model: this.options.model` 即可，
      // 适配器侧已经支持（claude.js / generic.js 都有 opts.model 分支）。
    })

    /*
     * 跑完再拍一张，与跑前那张一 diff，就是本次子任务在磁盘上留下的真实改动。
     *
     * 适配器自己给了 `changedFiles` 就尊重它（成员可能比引擎更清楚自己动了什么）；
     * 否则用引擎采集的结果 —— 采不全时它是 `null`，那就一路保持 `null`：
     * 「没采集」和「采集到零改动」在判定层含义相反，中途绝不能兜成 `[]`。
     */
    let changedFiles = r.changedFiles
    if (changedFiles == null && beforeSnap) {
      changedFiles = collectChanges(beforeSnap, snapshotTree(ctx.workdir, this.options.snapshotLimits || {}))
    }

    const entry = trace.upsert({
      ...base,
      status: r.status,
      text: r.text,
      // 产出有效性单列一档：status=ok 只代表进程正常退出，不代表产出可用。
      // 判定结果不改变流程，只作为提示 —— 详见 quality.js 的说明。
      /*
       * 把**结构化信号**一并交给判定，不只是文本。
       *
       * `permission_denials` 是适配器从 CLI 的 JSON 输出里取的。
       * 实测：那次「3/3 成功 · 0 失败、而产出全是废的」运行，
       * **唯一的证据就藏在这个字段里**（8 / 5 / 0 条被拦的命令），
       * 而文本本身 1027 / 587 / 475 字符，全部超过环境词 400 的长度门，正则怎么加都拦不住。
       */
      quality: judgeOutput(r.text, {
        status: r.status,
        permissionDenials: r.permissionDenials,
        changedFiles,
        permission: base.permission,
        // 把"这次有没有可能写"一起交给判定 —— 判定层不该自己去猜成员是谁。
        // 与上面决定要不要采集用的是**同一个** mayWrite，两处必须一致，
        // 否则就会出现"采集了但判定不认"（白采）或"没采集却敢定罪"（误报）。
        mayWrite,
      }),
      prompt,
      cost: r.cost || {},
      // ⚠️ 这里**不能**写 `|| []`。适配器/采集器用 `null` 表示"未采集"，
      // 一旦被兜成 `[]`，"没数据"就变成了"没有改动"，下游的 claimed-edit-no-change
      // 会在每一次写档运行上误报 —— 上游评审差点照这个写法落地，详见 quality.js 里的说明。
      changedFiles: changedFiles ?? null,
      // 空数组 = 上游齐备；非空 = 这次是带着缺口跑的（只在 salvage 策略下出现）
      degradedUpstream: degraded,
      durationMs: r.raw?.durationMs ?? 0,
      raw: r.raw || {},
    })

    ctx.results[st.id] = entry
    /*
     * ⚠️ 预算闸只数得到**报了美元成本**的那部分。
     *
     * 实测（2026-09-29）：qoder 按积分计费，CLI 里 `total_cost_usd` 恒为 0，
     * 真实消耗在 `total_credits`；cursor / trae 压根不返回成本。
     * `|| 0` 意味着这些成员的花费**对闸门完全不可见** ——
     * 一个全程用 qoder 的任务，`spentUsd` 会一直是 0，预算上限永远触发不了。
     *
     * 所以这里额外记下"有多少条没报美元成本"，让中止信息和报告都能说实话。
     * 要根治得给每个成员配一份单价表，那是另一件事（且汇率/单价都不该由我们编）。
     */
    ctx.spentUsd += r.cost?.usd || 0
    if (typeof r.cost?.usd !== 'number') ctx.unknownCostCount = (ctx.unknownCostCount || 0) + 1

    onEvent({ type: 'subtask-finish', ...entry })
    return entry
  }
}
