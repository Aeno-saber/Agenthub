/**
 * 适配器基类与统一数据结构
 *
 * 设计原则：引擎只认这套接口，不关心底下是哪个 CLI。
 * 新成员接进来 = 加一个适配器 + 一行配置，引擎不动。
 */
import { findRole } from '../roles.js'

/** 权限档位，由低到高 */
export const PERMISSION_LEVELS = ['readonly', 'plan', 'execute', 'full']

/** 档位中文名，用于日志和界面 */
export const PERMISSION_LABELS = {
  readonly: '只读',
  plan: '计划',
  execute: '执行',
  full: '全自动',
}

/**
 * 成员是否「可能改到磁盘上的文件」。
 *
 * 显式声明优先（`writeCapable`），缺省按能力标签推断 ——
 * 但推断只是兜底，**不该被当成判据**：能力标签是给规划者派活用的软标签，
 * 拿它当"能不能写文件"的硬事实是语义挪用。所以特例必须显式写出来，
 * 豆包（REST 文档成员）就在 members.json 里显式声明了 `writeCapable: false`。
 *
 * ★ 「不知道」的默认方向是 **true（可能写）**，不是 false。
 * 三种输入要分清：
 *   - `capabilities: ["doc"]`      —— 明确列了能力、里面没有写类 → **false**
 *   - `capabilities: ["code"]`     —— 有写类能力 → true
 *   - 缺 `capabilities` / 空数组   —— **不知道** → **true**
 *
 * 为什么"不知道"要选 true：判 false 会让引擎**跳过文件改动采集**，
 * 于是成员真写了文件也没人知道，判定层还因为"没数据"而永远不判 —— 静默失效。
 * 判 true 最多多跑一趟目录快照。**两边的代价不对称，就往贵的那边保守。**
 *
 * 为什么非要有这个概念：引擎在可能写的档位下会给工作目录拍快照、事后 diff 出文件改动，
 * 用来给「声称改了，磁盘上没变化」这条判定提供证据。可对一个**压根没有写文件能力**
 * 的成员（豆包只能发 REST 请求）来说，这个 diff 永远为空 ——
 * 而空数组在判定层的意思恰好是"采集过了，确实没改"，于是产出里写一句
 * "已创建文档"就会被判成可疑。**这是拿一把量不到东西的尺子去定罪。**
 */
export function isWriteCapable(spec) {
  if (typeof spec?.writeCapable === 'boolean') return spec.writeCapable
  const caps = spec?.capabilities
  if (!Array.isArray(caps) || caps.length === 0) return true
  return caps.includes('code') || caps.includes('shell')
}

/**
 * 如实描述「用户选的这一档，到底有没有真的传下去」。
 *
 * 起因（2026-09-29 审计）：三个适配器的 `permissionArgs()` 都写成
 *
 * ```js
 * return map[level] || map[spec.defaultPermission] || []
 * ```
 *
 * 这个写法有两个**不出声**的失败：
 *  1. 请求的档位没配 → 悄悄用默认档的参数顶上，**界面上仍显示用户选的那一档**；
 *  2. 请求的档位配成空数组 → 什么都不传，等于"该成员无法用参数表达这一档"，
 *     可用户看到的是「只读 —— 能读，不改文件、不跑命令」这样一句承诺。
 *
 * 实测（`node tests/perm-audit.mjs`）：trae 的 `readonly` 与 `plan` 都配成 `[]`，
 * 四个档位实际塌缩成两组 —— 用户区分不出来，引擎也不该假装能区分。
 *
 * 所以这里把「参数」和「这参数能不能代表用户要的档位」分成两件事返回：
 * `args` / `env` 仍然是要传给进程的东西（调用方照常用），`expressible` 才是判定依据。
 *
 * ★★ 2026-09-29 第二轮修正：**档位不一定只能用命令行参数表达**。
 * 原先只看 `permissionArgs`，于是把 DSH 记成"四档全 `[]`、权限无法表达"——
 * 那是**看错了地方**。`dsh --profile headless --help` 确实只有 `-h`，
 * 但它的权限是靠 `DSH_PERMISSION_MODE` 环境变量控的（`--dump-config` 里写得很清楚：
 * `sandbox-policy.mode` 与 `user-approval.policy` 都直接读这个变量）。
 * 实测三档行为确实不同：
 *
 * | `DSH_PERMISSION_MODE` | 写工作区内的文件 | 提权（越出工作区） |
 * |---|---|---|
 * | `read-only` | **被拒**：`[sandbox: file access denied under read-only mode]` | 拒 |
 * | `workspace-write`（默认） | 成功 | **fail-closed**（无审批通道 → 按拒绝处理） |
 * | `danger-full-access` | 成功 | 成功（审批 never） |
 *
 * **所以"该成员无法表达这一档"这句话，必须建立在"参数和环境变量都查过了"之上。**
 * 只查一个地方就下结论，会把能生效的档位说成不能生效 —— 那和"编造一个承诺"一样是错的。
 *
 * @param {object} spec members.json 里的单条成员配置
 * @param {string} level 用户请求的档位
 * @returns {{level:string, args:string[], env:Object<string,string>,
 *            source:'exact'|'fallback'|'none', effectiveLevel:?string, expressible:boolean}}
 *   `source: 'exact'`    —— 这一档有专属配置（唯一可能 expressible 的情况）
 *   `source: 'fallback'` —— 这一档没配，参数来自**别的档位**（默认档）；`env` 恒为空
 *   `source: 'none'`     —— 这一档没配（连默认档都没配），什么都不传
 *   `expressible`        —— 传下去的这串参数/环境变量，能不能代表用户选的档位
 */
export function describePermission(spec, level = 'plan') {
  const argMap = spec?.permissionArgs || {}
  const envMap = spec?.permissionEnv || {}
  const def = spec?.defaultPermission || 'plan'
  const has = (m, k) => Object.prototype.hasOwnProperty.call(m, k)
  const argsOf = (k) => (Array.isArray(argMap[k]) ? argMap[k] : [])
  const envOf = (k) => {
    const v = envMap[k]
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  }

  const exactly = has(argMap, level) || has(envMap, level)
  if (exactly) {
    const args = argsOf(level)
    const env = envOf(level)
    // 配了专属参数**或**专属环境变量、且非空 —— 这才叫"这一档真的生效了"
    return {
      level, args, env, source: 'exact', effectiveLevel: level,
      expressible: args.length > 0 || Object.keys(env).length > 0,
    }
  }

  // 拿默认档顶上：用户要 A 档，实际跑的是 B 档，必须能被看见。
  //
  // ★ 环境变量**不参与回落**，只认"这一档有专属配置"。
  //   参数是「请求」，环境变量是「授权」。把 B 档的授权拿去顶 A 档，
  //   方向正好是危险的那边 —— 用户点「只读」，却拿到了执行档的写权限，
  //   而界面上还写着"只读"。宁可什么都不设（按成员自己的默认来），
  //   也不要把授权往宽的方向顶。
  if (has(argMap, def) || has(envMap, def)) {
    return { level, args: argsOf(def), env: {}, source: 'fallback', effectiveLevel: def, expressible: false }
  }
  return { level, args: [], env: {}, source: 'none', effectiveLevel: null, expressible: false }
}

/**
 * @typedef {Object} RunOptions
 * @property {string} prompt           给成员的指令
 * @property {string} [workdir]        工作目录
 * @property {string} [permission]     权限档位，缺省取成员默认
 * @property {string} [model]          指定模型
 * @property {number} [timeoutMs]      超时
 * @property {number} [maxBudgetUsd]   花费上限（成员支持时生效）
 * @property {string} [role]           角色标签，会注入到系统提示
 */

/**
 * @typedef {Object} RunResult
 * @property {'ok'|'failed'|'timeout'} status
 * @property {string} text                       成员的文本产出
 * @property {?string[]} changedFiles          改动过的文件。`null` = **未采集**（当前三个适配器都是），
 *                                             `[]` = 采集了但没有改动。两者含义不同，不要混用。
 * @property {{usd?:number, inputTokens?:number, outputTokens?:number}} cost
 * @property {{command:string, exitCode:number|null, durationMs:number, stdout:string, stderr:string}} raw
 */

export class BaseAdapter {
  /** @param {object} spec members.json 里的单条成员配置 */
  constructor(spec) {
    this.spec = spec
  }

  get id() { return this.spec.id }
  get name() { return this.spec.name }
  get capabilities() { return this.spec.capabilities || [] }
  get isEnabled() { return this.spec.enabled !== false }

  /**
   * 这个成员把模型的输出**流式**交回来吗（一行一个事件），还是一次性给一大段？
   *
   * 为什么引擎要问这个：规划者会给"拆几个子任务、每条指令多长"设上限，
   * 而那两条上限**只为一件真实事故服务** —— 实测遇到过规划模型的输出写到一半被
   * 截断，后面的子任务整个丢掉、计划根本没法执行（见 docs/05 第七节）。
   * 会截断的是**一次性吐出整段**的那类：输出越长，风险越大。
   * 流式的（codex 的 `exec --json`）是逐事件交回来的，不存在"写到一半没了"，
   * 对它继续压这两条，等于白扔掉可用的规划能力 —— 拆得少、指令写得含糊，
   * 反而更容易在**执行**阶段失败。
   *
   * 默认 false：**没声明就当它会截断**，往保守那一侧走。
   */
  get streamsStructuredOutput() { return false }

  /**
   * 探测成员是否可用（必须实测，不能靠猜）
   * @returns {Promise<{available:boolean, version?:string, reason?:string, raw?:string}>}
   */
  async probe() {
    throw new Error(`${this.id}: probe() 未实现`)
  }

  /**
   * 执行一个子任务
   * @param {RunOptions} opts
   * @returns {Promise<RunResult>}
   */
  async run(opts) {
    throw new Error(`${this.id}: run() 未实现`)
  }
}

/**
 * 把角色标签展开成一段系统提示。
 * 这是"谁主笔、谁写文档"落到 prompt 层的地方。
 *
 * 预设表在 `src/roles.js`（唯一真相源）。**原来这里是硬编码的一份，
 * 而且漏了「执行者」—— 前端下拉框的默认值就是执行者。**
 * 于是"用默认角色"这条最常见的路径，落到模型头上的只有一句
 * 「你在本次任务中承担的角色是：执行者」，等于没写。教训是这份表不能有第二份。
 *
 * 未知角色仍然走兜底：计划可能是旧版本 localStorage 恢复出来的，
 * 也可能被手改过，认不出来也不该让整步任务失去角色说明。
 */
export function rolePrompt(role) {
  if (!role) return ''
  const hit = findRole(role)
  return hit ? hit.prompt : `你在本次任务中承担的角色是：${role}。`
}
