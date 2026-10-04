/**
 * 命令行进度日志 —— **报告之外的第二个消费者**。
 *
 * ## 为什么它单独成一个模块
 *
 * 两个原因，都很具体：
 *
 * 1. **它不许自己写格式化。** 这里原来是 `$${(usd || 0).toFixed(4)}`，
 *    与报告层的 `costCell()` 是两份独立实现。2026-09-29 报告层把「没上报」从 `$0.0000`
 *    改成了「未知」（第三轮整轮都在修这个），命令行**没跟着改** ——
 *    于是同一份数据，报告印「0.157648 积分」，终端印「$0.0000」。
 *    所以这里只做排版，格式化一律从 `engine/trace.js` 引。
 *
 * 2. **它必须能被测试直接 import。** 原来它藏在 `cli.js` 里，而 `cli.js` 是个脚本，
 *    一 import 就会跑 `main()`，于是这块代码**从来没有被任何测试碰过** ——
 *    这正是那个谎能活下来的原因。搬出来之后，`tests/cli-logger.test.mjs`
 *    就能拿桩事件直接断言"屏幕上到底印了什么"。
 *
 * ## 只列真会触发的事件
 *
 * 这里的事件来自 `Orchestrator.run()` 的路径：plan-start / batch-start /
 * subtask-start / subtask-finish / subtask-skip / aborted / plan-finish。
 * 单卡片重跑的那几个（`resume-start` / `subtask-member-changed`）**故意不写** ——
 * CLI 没有重试入口，写了就是死代码，而"死代码"本身就是这个仓库反复清理的东西。
 */
import { costCell, costTotalCell, skipCell, durationCell } from '../engine/trace.js'

/**
 * @param {boolean} verbose  false 时整个日志静默（测试用）
 * @returns {(evt:object)=>void}
 */
export function makeLogger(verbose = true) {
  return (evt) => {
    if (!verbose) return
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    switch (evt.type) {
      case 'plan-start':
        console.log(`\n${evt.preview}\n`)
        // 失败策略要说出来 —— 它决定"一步挂了之后剩下的活还跑不跑"，用户得心里有数
        console.log(`（失败策略：${evt.policy || 'skip-blocked'} —— 用 --on-failure abort|skip-blocked|salvage 改）`)
        break

      case 'batch-start':
        console.log(`▶ 第 ${evt.index}/${evt.total} 批${evt.parallel ? '（并行）' : ''}：${evt.ids.join(', ')}`)
        break

      case 'subtask-start':
        console.log(`  [${t}] → ${evt.memberName} / ${evt.role || '执行者'} 开始 ${evt.id}`)
        break

      case 'subtask-finish': {
        const icon = evt.status === 'ok' ? '✓' : '✗'
        /*
         * 花费格复用报告那一份 ——
         * 报了美元印美元、只报了积分印「0.157648 积分」、什么都没报印「未知」。
         */
        console.log(`  [${t}] ${icon} ${evt.id} ${evt.status} · ${evt.durationMs}ms · ${costCell(evt)}`)
        if (evt.status !== 'ok') console.log(`       ${String(evt.text).split('\n')[0].slice(0, 120)}`)
        break
      }

      case 'subtask-skip':
        // 没执行 ≠ 失败：这条没花钱、也没产出，用另一个符号，别和 ✗ 混在一起
        console.log(`  [${t}] ⊘ ${evt.id} 未执行 · ${String(evt.text).slice(0, 140)}`)
        break

      case 'aborted':
        console.log(`\n⛔ ${evt.reason}`)
        break

      case 'plan-finish': {
        const s = evt.summary
        console.log(
          `\n完成：${s.okCount}/${s.subtaskCount} 成功 · ${s.failedCount} 失败${skipCell(s)}` +
          ` · 总耗时 ${durationCell(s)} · 花费 ${costTotalCell(s)}`
        )
        /*
         * ★ 报告里有的警告，命令行也必须有。
         *
         * 少了这两行，一条"在上游缺了输入的情况下硬跑出来的结论"和一条
         * "进程正常退出但内容不像是有效结果"的产物，在终端里**都长得和干净成功一模一样** ——
         * 报告说了、终端没说，等于两个消费者各说各话，而用户更可能只看终端。
         */
        if (s.degradedCount) {
          console.log(
            `  ⚠️ 其中 ${s.degradedCount} 个是在上游有缺口的情况下跑的 —— ` +
            '成员本身正常，但输入少了一块，所以结论不完整'
          )
        }
        if (s.suspectCount) {
          console.log(
            `  ⚠️ 其中 ${s.suspectCount} 个产出可疑 —— 「成功」只说明没崩，不说明事办成了`
          )
        }
        break
      }

      default:
        // 不认识的类型静默跳过：不认识的**别瞎印**，比猜一个措辞强
        break
    }
  }
}
