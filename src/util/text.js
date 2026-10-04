/**
 * 纯文本处理工具 —— 被 adapters 和 engine 共用，所以单独放一层，避免 engine 反向依赖 adapters。
 */

/**
 * 截断但**保留头尾** —— 别只留开头。
 *
 * 这个函数在 2026-09-29 的一次真跑里被"逼"出来的，同一个坑当天踩到四次：
 *
 *  1. `ui/server.js` 的 `apiPlan`：`String(raw).slice(0, 2000)`
 *     → 把"规划输出被截断"这个关键证据自己切掉了，害我误判成 max tokens 问题。
 *  2. `adapters/generic.js` + `claude.js`：`cleanStderr(r.stderr).slice(0, 500)`
 *     → trae 挂掉时产出是 Python traceback，**异常类型在最后一行**，被切掉了，
 *       只剩一串 `File "<frozen runpy>", line 198`，完全无法定位失败原因。
 *  3. `engine/orchestrator.js` 的 `truncate`：`s.slice(0, n)`
 *     → 上游成员写的报告，**结论通常在末尾**，只留开头等于把结论扔掉。
 *
 * 规律：**报错信息和报告结论，一个在尾部，一个在尾部；而参数列表、目录结构在头部。**
 * 只保留头（或只保留尾）都会丢关键信息，所以两头都留，中间打省略标记。
 * 代价是几十个字符，收益是永远不用再猜"是不是被截断过"。
 */
export function elide(text, max = 500) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  const head = Math.ceil(max * 0.6)
  const tail = max - head
  if (tail <= 0) return s.slice(0, max)
  return `${s.slice(0, head)}\n…〔中间省略 ${s.length - max} 字符〕…\n${s.slice(-tail)}`
}
