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
import { describePermission, isWriteCapable } from '../adapters/base.js'

/**
 * 「自称没真正执行」的措辞。
 *
 * ⚠️ 这一组**从不单独生效** —— 只在有**结构化证据**（`permission_denials` 非空）时才采信。
 *
 * 为什么不单看文本：正常文档里也会写"以下命令尚未执行"、"这段没实测"，
 * 单凭措辞标记会制造大量误报 —— 而误报正是这个标记最不能犯的错。
 * `permission_denials` 则是引擎手里的**硬事实**：这次调用真的有命令被拦下了。
 * 两者同时成立，才是「写了但没验证」的可靠特征。
 */
const NOT_EXECUTED_PATTERNS = [
  /(尚未|没有|未能|无法|没能)(真正)?(执行|运行|实测|跑)/,
  /(被|遭)(权限|审批)?(拦截|拦下|拒绝)/,
  /权限拦截/,
  /requires approval/i,
  /(未|没)(真正)?实测/,
]

/**
 * 「声称已经把东西改了」的完成语。
 *
 * ⚠️ 和 `NOT_EXECUTED_PATTERNS` 一样，这组**从不单独生效**。
 * 光看到"已修复"就报警，等于给每一次正常改写都报警 —— 而这条规则唯一能定罪的证据是
 * `changedFiles`：写权限档 + 引擎**确实采集过**改动 + 采集结果是空。三者缺一不可。
 */
const CLAIM_EDIT_PATTERNS = [
  /已(写|写入|写好|改|修改|修复|新增|新建|创建|删除|重构|更新)/,
  /(修改|修复|新增|写入|创建|重构|更新)了/,
  /\b(implemented|fixed|updated|created|refactored|wrote|patched)\b/i,
]

/**
 * 有写入能力的权限档。`readonly` / `plan` 档本来就只出结论，零改动是正常的，不该判。
 *
 * 导出是因为**编排器要用同一份定义**来决定"哪些档才值得去采集文件改动" ——
 * 写两份迟早会不一致，而不一致的表现是"采集了但判定不认"，白白白跑一趟快照。
 */
export const WRITE_PERMISSIONS = new Set(['execute', 'full'])

/**
 * 这次子任务「有没有可能改到磁盘上的文件」—— **采集与定罪共用这一个判据**。
 *
 * 为什么不直接 `WRITE_PERMISSIONS.has(level)`：那个写法只信**用户请求的档位**，
 * 而请求的档位和实际生效的档位是两件事。实测（`node tests/perm-audit.mjs`）：
 *
 * | 成员 | readonly 传下去的参数 | 与 plan 是否一样 |
 * |---|---|---|
 * | claude | `--permission-mode dontAsk` | 否 |
 * | cursor | `--mode ask` | 否 |
 * | qoder  | `--permission-mode dont_ask` | 否 |
 * | trae   | `[]`（**什么都不传**） | **是** |
 * | dsh    | `[]`（四档全一样） | **是** |
 *
 * trae 那行是关键：界面上写着「只读 —— 能读，不改文件、不跑命令」，而实际上
 * 它收到的参数与 plan 档一模一样。老写法只看 `readonly ∉ WRITE_PERMISSIONS`
 * 就跳过采集 —— **成员真写了文件，引擎不仅不拦，还主动放弃了核对。**
 *
 * 所以除了"明确选了写档"，下面两种也必须按"可能写"处理：
 *  - 该档位**无法用参数表达**（`expressible: false`）：没有参数在约束它，承诺是空的；
 *  - 该档位没配、参数来自**别的档位**（`source: 'fallback'`）：跑的根本不是这一档。
 *
 * 唯一敢判"不可能写"的只有两种情况：成员本来就没有写文件的能力（豆包是 REST 成员），
 * 或者非写档**且**该档位真有专属参数在约束它。
 *
 * @param {object} spec  members.json 里的成员配置
 * @param {string} level 用户请求的档位
 */
export function memberMayWrite(spec, level) {
  // REST 型成员（豆包只能发请求）没有文件系统能力，采了也是白采，且采到空集必然误报
  if (!isWriteCapable(spec)) return false
  if (WRITE_PERMISSIONS.has(String(level || ''))) return true
  return !describePermission(spec, level).expressible
}

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
 * @param {{status?:string, permissionDenials?:Array, changedFiles?:?string[], permission?:string,
 *          mayWrite?:boolean}} [meta]
 *        `permissionDenials`：本次调用被权限拦截的命令清单（适配器从 CLI 的结构化输出里取）。
 *        `changedFiles`：采集到的文件改动清单。**`null`/`undefined` 表示「没采集」，
 *        与 `[]`（采集了但没有改动）是两件事** —— 这个区分是 `claimed-edit-no-change` 的安全带。
 *        `permission`：本次子任务用的权限档（readonly/plan/execute/full）。
 *        `mayWrite`：这次**有没有可能**改到文件（由编排器按 `memberMayWrite()` 算好传进来，
 *        因为它才知道成员是谁）。不传则退化为只看 `permission`。
 * @returns {{level:'ok'|'suspect', codes:string[], note:string}}
 */
export function judgeOutput(text, meta = {}) {
  const ok = { level: 'ok', codes: [], note: '' }

  // 已经是失败/超时，不需要再判 —— 那个状态本身就说清了
  if (meta.status && meta.status !== 'ok') return ok

  const t = typeof text === 'string' ? text.trim() : ''
  if (!t) return { level: 'suspect', codes: ['empty'], note: '产出为空' }

  /*
   * ★ 结构化信号优先：本次调用有命令被权限拦截，且产出自己也承认「没真正执行」。
   *
   * 实测样本（2026-09-29 的真实运行 `.agenthub/runs/run-1790658473692.json`）：
   * 三个子任务的产出全写着「测试文件已写好，但命令被 `This command requires approval` 拦截、
   * 未真正执行」，而 `status` 全是 ok、整次运行报「3/3 成功 · 0 失败」。
   * 那次的 `permission_denials` 分别是 8 / 5 / 0 条。
   *
   * 为什么现有 19 条正则一条都拦不住：**而且加词也没用** ——
   * 即便把 "requires approval" 补进 `ENV_ERROR_PATTERNS`，那三条产出是
   * 1027 / 587 / 475 字符，**全部超过 400 的长度门**，环境词根本不采信。
   *
   * 所以这条规则的关键在于：**它不依赖文本长度**，靠的是引擎手里的结构化事实。
   * 这也是「产出有效性判定」从"猜文本"迈向"看证据"的第一步。
   */
  const denials = Array.isArray(meta.permissionDenials) ? meta.permissionDenials.length : 0
  if (denials > 0 && NOT_EXECUTED_PATTERNS.some((re) => re.test(t))) {
    return {
      level: 'suspect',
      codes: ['not-executed'],
      note: `本次调用有 ${denials} 条命令被权限拦截，产出也自称未真正执行 —— 像是「写了但没验证」，建议核对上面那些命令到底跑没跑`,
    }
  }

  /*
   * ★ 「声称改了，但磁盘上没变化」。
   *
   * 三个条件同时成立才判：
   *   1) 这次子任务**有可能写文件** —— 见 `memberMayWrite()`。它不是只看权限档：
   *      成员没有写能力（豆包）→ 不可能写；档位无法表达（trae 的只读）→ 按"可能写"处理；
   *   2) `changedFiles` **是数组** —— 即引擎确实采集过（null/undefined = 没采集）；
   *   3) 采集结果是空。
   *
   * ⚠️ 第 2 条是这条规则的安全带，缺了它会变成一条**恒定误报**的规则：
   * `.agenthub/runs/*.json` 里曾经**全部 13 个条目**的 `changedFiles` 都是 `[]`，
   * 因为三个适配器都硬编码返回空数组、从来没有谁填过它。那时
   * 「声称改动 && length === 0」只要正文提到"已修改"就恒为真。
   * 所以适配器一律改用 `null` 表示「未采集」，采集只在 `memberMayWrite()` 为真时发生。
   *
   * ⚠️ 这段注释曾经写着「这条规则目前不会触发，因为还没采集数据」——
   * **那是过期信息**。编排器 `runOne()` 已经在写档下拍快照 + diff 拿真实改动了
   * （`snapshotTree` / `collectChanges`），只是采集面被 `WRITE_PERMISSIONS.has()` 那一个
   * 条件框住，所以 trae 的只读档永远采不到。修订记录见 docs/05。
   */
  const cf = meta.changedFiles
  // `mayWrite` 由编排器算好传进来（它知道成员是谁）；没传时退化为只看权限档，
  // 这样单测里只给 permission 的老调用方式仍然有效。
  const mayWrite = meta.mayWrite ?? WRITE_PERMISSIONS.has(String(meta.permission || ''))
  if (
    Array.isArray(cf) &&
    cf.length === 0 &&
    mayWrite &&
    CLAIM_EDIT_PATTERNS.some((re) => re.test(t))
  ) {
    return {
      level: 'suspect',
      codes: ['claimed-edit-no-change'],
      note: '产出声称已完成改动，而本次在写权限档下采集到的文件改动为空 —— 建议核对磁盘上到底有没有变',
    }
  }

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
