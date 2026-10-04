/**
 * 产出有效性判定 —— 补上"L3 冒烟"这层
 *
 * ## 为什么需要它
 *
 * 成员调用返回的 `status: 'ok'` 只代表**进程正常退出**（退出码 0），
 * 不代表产出可用。这两件事经常被混为一谈。
 *
 * 2026-09-29 实测踩到过：一次 `run_plan` 报「3 / 3 成功 · 0 失败」，
 * 退出码全是 0，而三个成员的产出全是
 * 「你这条消息只有标题【任务总目标】，还没有具体内容」——
 * 因为多行 prompt 经 `cmd.exe` 命令行传参时被换行就地截断了。
 * 只看 status 字段，那次运行会被判成满分。
 *
 * ## 判定策略：宁漏勿误
 *
 * 这里全是启发式规则，会误报。所以刻意**保守**：
 *  - 只在「产出结构性地不可能合格」时才标记（空、过短、命中推诿模板）；
 *  - 环境类错误词（"not logged in" 等）只在产出**很短**时才算，
 *    否则长文档里正常引用这些词也会被误伤；
 *  - 不确定就判 ok —— 一个会喊狼来了的标记，比没有标记更糟。
 *
 * 判定结果**不改变** status 与执行流程，只作为提示附加在结果上。
 */

/** 推诿/占位模板：出现这些，说明它压根没收到有效指令 */
const REFUSAL_PATTERNS = [
  /还没有具体(内容|任务|说明)/,
  /没有(具体|任何)?(的)?(任务)?内容/,
  /请(补充|提供|把).{0,16}(目标|内容|需求|说明|信息|指令|约束)/,
  /您(的)?消息(中|里)?.{0,10}(是)?空/,
  /(我)?(没有|未|没)收到.{0,12}(内容|指令|任务|需求|具体)/,
  /您的消息(中|里)/,
  /please provide (more|the|your)/i,
  /no (specific )?(content|task|instructions|requirements)/i,
  /I (don't|do not) see (any )?(content|task|instructions)/i,
  /there('s| is) no (content|task|prompt)/i,
]

/** 环境/凭据类错误：退出了，但事没干成。只在短产出时采信 */
const ENV_ERROR_PATTERNS = [
  /Not logged in/i,
  /Please run \/login/i,
  /command not found/i,
  /不是内部或外部命令/,
  /is not recognized as an? (internal|external)/i,
  /Workspace Trust Required/i,
  /spawn .{0,40}ENOENT/i,
  /permission denied/i,
  /unauthorized|invalid api key|401/i,
]

/** 短产出阈值：低于此长度才认为"环境错误词"是主信息而非法文引用 */
const SHORT_TEXT_CHARS = 400
/**
 * 推诿判定只在短产出上生效。
 * 真正的"我没收到指令"回应都很短（实测样本 54 / 154 字符）；
 * 而长产出里正常讨论"用户没有提供具体内容"是常见写法，不该误伤。
 */
const REFUSAL_MAX_CHARS = 800

/**
 * @param {string} text  成员产出
 * @param {{status?:string}} [meta]
 * @returns {{level:'ok'|'suspect', codes:string[], note:string}}
 */
export function judgeOutput(text, meta = {}) {
  const ok = { level: 'ok', codes: [], note: '' }

  // 已经是失败/超时，不需要再判 —— 那个状态本身就说清了
  if (meta.status && meta.status !== 'ok') return ok

  const t = typeof text === 'string' ? text.trim() : ''
  if (!t) return { level: 'suspect', codes: ['empty'], note: '产出为空' }

  // 刻意**不**按"过短"判定：合法答案经常极短。
  // 实测样本：协同验证里 s3 的正确产出就是 "5"（1 个字符）。
  // 按长度判会把正确答案标成可疑 —— 误报比漏报更伤这个标记的可信度。

  if (t.length <= REFUSAL_MAX_CHARS) {
    const hit = REFUSAL_PATTERNS.find((re) => re.test(t))
    if (hit) {
      return {
        level: 'suspect',
        codes: ['template-refusal'],
        note: '产出像是在要求补充信息（不是结果）—— 常见于 prompt 未真正送达，建议核对上面的命令与传参方式',
      }
    }
  }

  if (t.length <= SHORT_TEXT_CHARS) {
    const envHit = ENV_ERROR_PATTERNS.find((re) => re.test(t))
    if (envHit) {
      return {
        level: 'suspect',
        codes: ['env-error'],
        note: '产出像是环境/凭据错误（未登录、命令不存在、目录未受信等），任务可能并未真正执行',
      }
    }
  }

  return ok
}

/** 人话渲染，给报告用；ok 返回空串 */
export function describeQuality(quality) {
  if (!quality || quality.level !== 'suspect') return ''
  return `产出可疑（${quality.codes.join(' / ')}）：${quality.note}`
}
