/**
 * 运行轨迹 —— 记录谁在何时收到什么、输出什么、耗时多少、花了多少钱
 * 第一期的验收物就是它产出的报告。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeQuality } from './quality.js'

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n) + `\n…（截断，原文 ${s.length} 字符）` : s || '')

/**
 * 单个**成本对象**的展示 —— 报了美元 / 只报了积分 / 什么都没报。
 *
 * 三种情况必须长得不一样。一律印 `$0.0000` 会让「没数据」看起来像「免费」——
 * 而实测里那个被印成 $0 的子任务，跑了 6.5 分钟、烧掉 0.16 积分。
 *
 * 单独抽出来（而不是只留 `costCell(e)`），是因为命令行也要印同一格，
 * 而它手上只有 `evt.cost`，没有完整的 entry。**一份格式化函数只留一份** ——
 * 两个消费者各写各的，迟早不一致。2026-09-29 就是这么发生的：
 * 报告印「0.157648 积分」，同一份数据命令行印「$0.0000」。
 */
export function costOf(cost) {
  if (typeof cost?.usd === 'number') return `$${cost.usd.toFixed(4)}`
  if (typeof cost?.credits === 'number') return `${cost.credits} 积分`
  return '未知'
}

/** 单条子任务的花费格 —— 未执行的条目花费是**已知的零**，印 `—`。 */
export function costCell(e) {
  /*
   * 没执行的条目花费是**已知的零**（压根没调用成员），不是"未知"。
   * 所以印 `—` 而不是 `未知` —— 后者会被读成"花了但没记下来"。
   * 和上面那条铁律是同一个方向：`未知` 只留给"真的没数据"。
   */
  if (e.status === 'skipped') return '—'
  return costOf(e.cost)
}

/**
 * 结果行里的「未执行」那一格 —— 没有未执行条目时整段不出现。
 * 和"失败"分开写，是因为两者该引起的第一反应不同：
 * 失败要去看产出、考虑重试；没执行要看失败策略和预算，重试也没用。
 */
export function skipCell(s) {
  if (!s.skippedCount) return ''
  const parts = []
  if (s.skippedByKind.blocked) parts.push(`${s.skippedByKind.blocked} 条依赖断链`)
  if (s.skippedByKind.aborted) parts.push(`${s.skippedByKind.aborted} 条策略中止`)
  if (s.skippedByKind.budget) parts.push(`${s.skippedByKind.budget} 条预算上限`)
  if (s.skippedByKind.user) parts.push(`${s.skippedByKind.user} 条由用户跳过`)
  return `  ·  ${s.skippedCount} 未执行（引擎未调用成员${parts.length ? '：' + parts.join('、') : ''}）`
}

/**
 * 表格里的状态格。
 *
 * `ok` 但**带着上游缺口**的，必须长得和"干净的 ok"不一样 ——
 * 否则一条"在上游缺失下硬跑出来的结论"会和一条"输入齐备的结论"在表里毫无区别，
 * 而那正是把"半份成果"当"完整成果"递出去的地方。
 */
function statusCell(e) {
  if (e.status === 'skipped') return '未执行'
  const flag = e.status === 'ok' && e.quality?.level === 'suspect' ? 'ok ⚠️' : e.status
  return (e.degradedUpstream || []).length ? `${flag} ⚠️缺口` : flag
}

/**
 * 结果行里的「花费」那一格。
 *
 * ★ 一个都没上报时**绝不能印 `$0`** —— 那等于宣称"这次免费"，而事实是没拿到数据。
 *
 * 上一轮堵的是**单格**的 `$0.0000`（改成"未知"），
 * 但总数这一格是直接 `$${totalCostUsd}`，而 totalCostUsd 在"零个上报"时就是 0，
 * 于是总数仍然印出 `花费 $0` —— 同一个谎换到了汇总行。这是 2026-09-29 生成报告样本时看出来的。
 *
 * 所以要分四种情况，而不是一句模板：
 *  - 有人报了        → 印总数 + 加注（只在并非全部上报时出现）
 *  - 只有积分        → 明说"未折算成美元"，并给出积分合计
 *  - 谁都没报、但确实跑过 → "未知"，不许印 0
 *  - 一条都没执行    → "无" —— 这是**已知的零**，可以印
 */
export function costTotalCell(s) {
  const reported = s.executedCount - s.costUnknownCount
  if (reported > 0) return `$${s.totalCostUsd}${costCaveat(s)}`
  if (s.executedCount === 0) return '无（没有任何子任务被执行）'
  if (s.creditsReportedCount) {
    return `未折算成美元（${s.creditsReportedCount} 个子任务按积分计费，合计 ${s.totalCredits} 积分）`
  }
  return `未知（${s.executedCount} 个实际执行的子任务都没有上报成本）`
}

/**
 * 花费总数后面的加注 —— 只在"并非每个子任务都报了美元成本"时出现。
 * 没有这一句，那行 `$0.65` 看起来就是个确定的数字。
 */
function costCaveat(s) {
  if (!s.costUnknownCount) return ''
  if (s.creditsReportedCount) {
    return `（⚠️ 另有 ${s.costUnknownCount} 个子任务按积分计费 · 合计 ${s.totalCredits} 积分，未折算成美元 —— 实际花费高于此数）`
  }
  return `（⚠️ 另有 ${s.costUnknownCount} 个子任务未上报成本 —— 实际花费高于此数）`
}

/**
 * 结果行里的「总耗时」那一格。
 *
 * ★ 和花费那一格同一条规矩：**`0` 不是测量值。**
 *
 * `finishedAt` 为空说明这次运行**没有正常收尾**，此时 `durationMs` 就是初始值 0 ——
 * 印 `0.0s` 等于宣称"这次跑完只用了 0 秒"，而事实是**没测到**。
 *
 * 这条不是假想出来的：2026-09-29 抽 `advance()` 时，
 * `run()` 结尾的 `trace.finish()` 被一起搬进了 `resume()`，
 * 于是整单首跑的 `finishedAt` 恒为 `null`、报告里「总耗时 0.0s」印了两轮，
 * 而**没有任何断言覆盖它**。把"没测到"显式说出来，至少它不会再装作是个数字。
 */
export function durationCell(s) {
  if (!s.finishedAt) return '未知（运行没有正常收尾）'
  return `${(s.durationMs / 1000).toFixed(1)}s`
}

export class Trace {
  constructor(goal) {
    this.goal = goal
    this.startedAt = new Date()
    this.entries = []
    this.finishedAt = null
    this.durationMs = 0
  }

  add(entry) {
    const row = { index: this.entries.length + 1, ...entry }
    this.entries.push(row)
    return row
  }

  /**
   * 就地更新同一个子任务的记录；没有就新增。
   *
   * ★ 单卡片重跑必须走这个，不能用 `add`。
   * 重跑一次就多一条记录的话，报告里会出现同一个子任务两条
   * （一条旧的 failed、一条新的 ok），于是 `subtaskCount`、"3/5 成功"全都不再等于计划条数 ——
   * 而"轨迹条数 === 计划条数"正是上一轮拿来当"不许无声消失"的横切保证，破了它两边都不可信。
   *
   * `index` 保留原来的：那代表"这一步在计划里的位置"，重跑不会让它的位次漂移。
   */
  upsert(entry) {
    const i = this.entries.findIndex((e) => e.id === entry.id)
    if (i < 0) return this.add(entry)
    this.entries[i] = { ...this.entries[i], ...entry, index: this.entries[i].index }
    return this.entries[i]
  }

  finish() {
    this.finishedAt = new Date()
    this.durationMs = this.finishedAt - this.startedAt
  }

  get summary() {
    /*
     * ★ 花费要能区分「没人报」和「报了 0」。
     *
     * 实测（2026-09-29）：qoder 按**积分**计费，它的 CLI 里 `total_cost_usd` 恒为 0，
     * 真实消耗在 `total_credits`。cursor / trae 的 CLI 压根不返回成本。
     * 如果把这些一律按 0 累加，报告会印出一个 `$0.65` 的总数 ——
     * 而那个数漏掉了一次 6.5 分钟、烧掉 0.16 积分的调用。
     * **"没数据"被四舍五入成了"免费"**，和这一整轮在修的是同一类问题。
     *
     * 所以这里同时统计"报了的条数"与"没报的条数"，让报告层有话说。
     */
    /*
     * ★ 三种状态要分开数：**成功 / 失败 / 未执行**。
     *
     * `status: 'skipped'` 表示引擎**压根没调用成员**（依赖断链、策略中止、预算上限），
     * 所以它没花钱、也没产出。原来的 `failedCount` 写的是 `status !== 'ok'`，
     * 一旦有 skipped 条目混进来，报告就会说"3 个失败" ——
     * 而实际上一个成员都没跑、一分钱没花。**失败和没执行是两件事**：
     * 前者要看产出、要考虑重试；后者只需要看策略和预算。
     *
     * 同时，成本与 token 的分母也必须是"真的调用过的条数"，
     * 否则 skipped 条目会被算进"没上报成本"里，注脚上的数字又是假的。
     */
    const skipped = this.entries.filter((e) => e.status === 'skipped')
    const executed = this.entries.filter((e) => e.status !== 'skipped')
    const usdEntries = executed.filter((e) => typeof e.cost?.usd === 'number')
    const creditsEntries = executed.filter((e) => typeof e.cost?.credits === 'number')
    const tokenEntries = executed.filter(
      (e) => typeof e.cost?.inputTokens === 'number' || typeof e.cost?.outputTokens === 'number'
    )
    const totalCost = usdEntries.reduce((s, e) => s + e.cost.usd, 0)
    const totalIn = tokenEntries.reduce((s, e) => s + (e.cost?.inputTokens || 0), 0)
    const totalOut = tokenEntries.reduce((s, e) => s + (e.cost?.outputTokens || 0), 0)
    return {
      goal: this.goal,
      subtaskCount: this.entries.length,
      // 真正调用过成员的条数 —— 成本、token 的统计分母
      executedCount: executed.length,
      okCount: this.entries.filter((e) => e.status === 'ok').length,
      // 只数"调用了但没干成"，不把 skipped 算进来
      failedCount: executed.filter((e) => e.status !== 'ok').length,
      // 引擎没调用成员的条数（依赖断链 / 策略中止 / 预算上限），按原因分开
      skippedCount: skipped.length,
      skippedByKind: {
        blocked: skipped.filter((e) => e.skipKind === 'blocked').length,
        aborted: skipped.filter((e) => e.skipKind === 'aborted').length,
        budget: skipped.filter((e) => e.skipKind === 'budget').length,
        // 用户主动放弃 —— 和上面三种不是一类：那是**人的决定**，不是引擎的策略
        user: skipped.filter((e) => e.skipKind === 'user').length,
      },
      // 在上游有缺口的情况下跑出来的条数（只有 salvage 策略会产生）——
      // 它自己可能是 ok，但结论是**不完整**的，报告必须能说出来
      degradedCount: this.entries.filter((e) => (e.degradedUpstream || []).length).length,
      // 进程成功但产出可疑的条数 —— 见 quality.js。
      // 这两个数字相加才是"真正可用"的数量，只报 okCount 会给出假绿。
      suspectCount: this.entries.filter((e) => e.quality?.level === 'suspect').length,
      totalCostUsd: Number(totalCost.toFixed(4)),
      // 没报美元成本的条数 —— 报告必须据此加注，别让 $ 总数显得很确定
      costUnknownCount: executed.length - usdEntries.length,
      // 按积分计费的那部分：单独记，不折算成美元（汇率/单价都不该由我们编）
      creditsReportedCount: creditsEntries.length,
      totalCredits: Number(creditsEntries.reduce((s, e) => s + e.cost.credits, 0).toFixed(6)),
      // token 同理：0 个上报就说明"没采集"，不是"没消耗"
      tokenReportedCount: tokenEntries.length,
      totalInputTokens: totalIn,
      totalOutputTokens: totalOut,
      durationMs: this.durationMs,
      startedAt: this.startedAt.toISOString(),
      finishedAt: this.finishedAt ? this.finishedAt.toISOString() : null,
    }
  }

  toJSON() {
    return { ...this.summary, entries: this.entries }
  }

  toMarkdown() {
    const s = this.summary
    const lines = []
    lines.push('# 运行轨迹报告')
    lines.push('')
    lines.push(`**目标**：${s.goal}`)
    lines.push('')
    lines.push(`**结果**：${s.okCount} / ${s.subtaskCount} 成功  ·  ${s.failedCount} 失败${skipCell(s)}  ·  总耗时 ${durationCell(s)}  ·  花费 ${costTotalCell(s)}`)
    if (s.degradedCount) {
      lines.push('')
      lines.push(`> ⚠️ **其中 ${s.degradedCount} 个是在上游有缺口的情况下跑的** —— ` +
        '\n> 成员本身正常完成了，但它的输入少了一块，所以结论**不完整**。逐条见下面的「上游缺口」。')
    }
    if (s.suspectCount) {
      lines.push('')
      lines.push(`> ⚠️ **其中 ${s.suspectCount} 个产出可疑** —— 进程正常退出（退出码 0），但内容不像是有效结果。` +
        `\n> 「成功」只说明没崩，不说明事办成了。请看下面的逐条说明。`)
    }
    lines.push('')
    if (s.tokenReportedCount) {
      lines.push(`**Token**：输入 ${s.totalInputTokens} / 输出 ${s.totalOutputTokens}` +
        (s.tokenReportedCount < s.executedCount ? `（仅 ${s.tokenReportedCount} / ${s.executedCount} 个实际执行的子任务上报）` : ''))
    } else {
      lines.push('**Token**：未采集（没有成员上报 token 用量）')
    }
    lines.push('')
    lines.push('| # | 子任务 | 成员 | 角色 | 状态 | 耗时 | 花费 |')
    lines.push('|---|---|---|---|---|---|---|')
    for (const e of this.entries) {
      lines.push(
        `| ${e.index} | ${e.id} ${e.title || ''} | ${e.memberName || e.memberId} | ${e.role || '-'} | ${statusCell(e)} | ${e.durationMs}ms | ${costCell(e)} |`
      )
    }
    lines.push('')
    for (const e of this.entries) {
      if (e.status === 'skipped') {
        /*
         * 没执行的子任务走一条**短**的记录：没必要印"给它的指令"和"它的产出"——
         * 那两格本来就是空的，印出来只会让人误以为它跑了、什么都没交。
         */
        lines.push(`## ${e.index}. [${e.id}] ${e.title || ''} — ${e.memberName || e.memberId} / ${e.role || '执行者'}`)
        lines.push('')
        lines.push(`- 状态：**未执行**（引擎没有调用成员 —— 本次没有产生任何消耗）`)
        lines.push(`- 原因：${e.text}`)
        if (Array.isArray(e.dependsOn) && e.dependsOn.length) lines.push(`- 依赖：${e.dependsOn.join('、')}`)
        lines.push('')
        continue
      }
      lines.push(`## ${e.index}. [${e.id}] ${e.title || ''} — ${e.memberName || e.memberId} / ${e.role || '执行者'}`)
      lines.push('')
      lines.push(`- 状态：${e.status}`)
      if ((e.degradedUpstream || []).length) {
        lines.push(`- ⚠️ **上游缺口**：本任务是在 ${e.degradedUpstream.join('、')} 没有可用产出的情况下执行的，` +
          '结论可能不完整 —— 请对照上面那几条的失败/跳过原因一起看')
      }
      if (describeQuality(e.quality)) lines.push(`- ⚠️ ${describeQuality(e.quality)}`)
      lines.push(`- 耗时：${e.durationMs}ms　退出码：${e.raw?.exitCode}`)
      // 只在这种情况下补一行说明 —— 正常报了美元成本的不重复啰嗦
      if (typeof e.cost?.usd !== 'number') {
        lines.push(`- 花费：${costCell(e)}` + (typeof e.cost?.credits === 'number'
          ? '（该成员按积分计费，CLI 不返回美元成本）'
          : '（该成员未上报成本）'))
      }
      lines.push(`- 命令：\`${e.raw?.command || ''}\``)
      /*
       * 文件改动要区分「未采集」和「采集到零改动」。
       *
       * 报告层如果一律写成"无改动"，就等于把"我没看"说成"我看过了、没有" ——
       * 和 changes.js / quality.js 里防的是同一个错，只是换到了给人看的那一层。
       */
      if (Array.isArray(e.changedFiles)) {
        lines.push(
          e.changedFiles.length
            ? `- 改动文件（${e.changedFiles.length}）：${e.changedFiles.slice(0, 12).join('、')}${e.changedFiles.length > 12 ? ' 等' : ''}`
            : '- 改动文件：**无**（已完整采集）'
        )
      } else {
        lines.push('- 改动文件：未采集（该权限档不采集，或快照超限／目录不可读）')
      }
      if (e.raw?.stderr) lines.push(`- stderr：\`${truncate(e.raw.stderr, 300).replace(/\n/g, ' ')}\``)
      lines.push('')
      lines.push('**给它的指令（节选）**')
      lines.push('')
      lines.push('```')
      lines.push(truncate(e.prompt, 800))
      lines.push('```')
      lines.push('')
      lines.push('**它的产出**')
      lines.push('')
      lines.push('```')
      lines.push(truncate(e.text, 3000))
      lines.push('```')
      lines.push('')
    }
    return lines.join('\n')
  }

  save(dir, basename = 'trace') {
    mkdirSync(dir, { recursive: true })
    const jsonPath = join(dir, `${basename}.json`)
    const mdPath = join(dir, `${basename}.md`)
    writeFileSync(jsonPath, JSON.stringify(this.toJSON(), null, 2), 'utf8')
    writeFileSync(mdPath, this.toMarkdown(), 'utf8')
    return { jsonPath, mdPath }
  }
}
