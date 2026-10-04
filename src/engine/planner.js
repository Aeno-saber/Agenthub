/**
 * 任务拆解 —— 让一个成员充当"规划者"，把目标拆成子任务计划
 *
 * 说明：本项目的"主脑"是 WorkBuddy 本体（它在 MCP 那侧）。
 * 这个模块是"引擎自己拆"的兜底路径，用于无人值守场景。
 * 第一期两条路都能走：
 *   A. WorkBuddy 拆好 → 直接把 plan.json 交给引擎（推荐）
 *   B. 引擎调一个成员来拆（本模块）
 */
import process from 'node:process'
import { roleCatalogText, ROLE_LABELS } from '../roles.js'

/** 从模型输出里尽力抠出 JSON —— 模型不一定老实只输出 JSON */
export function extractJson(text) {
  if (!text) return null
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence ? fence[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 截断抢救
/*
 * 为什么需要这个：实测踩到过一次 —— 规划者给每个子任务写了很长的 prompt，
 * 输出到第 2 个子任务中途就被截断，结尾的 ``` 围栏压根没吐出来。
 * extractJson 要求围栏成对，匹配失败后退回全文 + lastIndexOf('}')，
 * 拿到的是不完整 JSON → parse 抛错 → 返回 null。
 * 界面上只显示「没拆出可用计划」，看不出是"被截断了"，
 * 而且**整个任务因此起不来**（其实前 1~2 个子任务是好的，人工补完就能跑）。
 *
 * 所以这里做"抢救"：尽量把已生成的那部分救出来，并明确告诉调用方"这是抢救来的，不完整"。
 */

/** 扫描一遍，拿到括号栈、是否停在字符串中间、以及各种可用的截断点 */
function scanJson(s) {
  const stack = []
  let inStr = false
  let esc = false
  let lastClosedElem = -1 // 顶层对象内、某个数组元素刚完整闭合的位置（此刻栈恒为 ['{','[']）
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{' || c === '[') stack.push(c)
    else if (c === '}' || c === ']') {
      stack.pop()
      // 栈回到「顶层对象 + 一个数组」这一层，说明数组里的某个元素完整闭合了
      if (stack.length === 2 && stack[1] === '[') lastClosedElem = i + 1
    }
  }
  return { stack, inStr, lastClosedElem }
}

/** 把一段"截断的 JSON 前缀"按当前括号栈补齐闭合符 */
function completeJson(s) {
  const { stack, inStr } = scanJson(s)
  let out = s
  if (inStr) out += '"'          // 截在字符串中间 → 补上引号
  out = out.replace(/[,:\s]+$/, '') // 去掉悬挂的逗号/冒号/空白
  const closers = []
  for (let i = stack.length - 1; i >= 0; i--) closers.push(stack[i] === '{' ? '}' : ']')
  return out + closers.join('')
}

/** 依次取出「成对围栏内」「未闭合围栏内」「全文」三种候选体 */
function jsonBodies(text) {
  const out = []
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) out.push(fenced[1])
  // 只有开头 ``` 没有结尾 —— 截断的典型特征
  const openFenced = text.match(/```(?:json)?\s*([\s\S]*)$/i)
  if (openFenced) out.push(openFenced[1])
  out.push(text)
  return out
}

/**
 * 尽力抢救被截断的 JSON。
 * @param {string} text 模型原始输出
 * @param {{minArrayField?:string, minItems?:number, itemFields?:string[]}} opts 形状要求
 * @returns {{value:object|null, repaired:boolean, reason:string}}
 */
export function extractJsonLoose(text, opts = {}) {
  if (!text || typeof text !== 'string') return { value: null, repaired: false, reason: '空输出' }

  const { minArrayField, minItems = 1 } = opts

  /*
   * ★ 元素级校验 —— 双保险，缺一不可。
   *
   * 只检查「数组非空」是不够的。2026-09-29 第二轮真跑就栽在这里：
   * 截断抢救回退若干段后，勉强拼出一个「有 3 个子任务」的 JSON，
   * 但第三个只剩 {id,title,memberId,role}，**没有 prompt**。
   * 旧校验只看数组长度 → 判定"抢救成功" → 界面照常渲染一张计划表、
   * 照常放行「确认执行」→ 直到服务端 `validatePlan` 才报
   * 「子任务 s3 缺少 prompt」—— 用户白点一次，且界面上完全没提示哪里缺。
   *
   * 教训：**抢救的产物必须能通过引擎校验，否则不算抢救成功。**
   * 交给引擎会被拒的计划，不如老老实实说"没拆出来"。
   */
  const needFields = opts.itemFields || (minArrayField === 'subtasks' ? ['id', 'prompt'] : [])
  const itemOk = (it) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return false
    return needFields.every((f) => {
      const v = it[f]
      return typeof v === 'string' ? v.trim().length > 0 : v != null
    })
  }
  const okShape = (v) => {
    if (!v || typeof v !== 'object') return false
    if (!minArrayField) return true
    const arr = v[minArrayField]
    if (!Array.isArray(arr) || arr.length < minItems) return false
    return arr.every(itemOk)
  }
  const attempt = (cand) => {
    if (!cand) return null
    try {
      const v = JSON.parse(cand)
      return okShape(v) ? v : null
    } catch { return null }
  }

  /*
   * 严格版也要过形状校验。
   * 「JSON 语法完整」不等于「计划可用」—— 子任务缺 prompt 的 JSON 是合法的，
   * 但引擎会拒绝执行它。所以形状不合格时继续往抢救路径走，救不出来就老实返回 null。
   */
  const strict = extractJson(text)
  if (strict && okShape(strict)) return { value: strict, repaired: false, reason: '' }

  for (const body of jsonBodies(text)) {
    const start = body.indexOf('{')
    if (start === -1) continue
    const s = body.slice(start)

    // 候选 A（最优先）：截到「最后一个完整闭合的数组元素」，保留前面已写好的子任务
    //   此刻栈必然是 ['{','[']，所以补一个 ] 一个 } 就闭合了
    const { lastClosedElem } = scanJson(s)
    if (lastClosedElem > 0) {
      const got = attempt(s.slice(0, lastClosedElem) + ']}')
      if (got) return { value: got, repaired: true, reason: '输出被截断，已保留最后一个完整项' }
    }

    // 候选 B：直接把括号补齐（截在字符串/键值对中间的常见情形）
    const gotB = attempt(completeJson(s))
    if (gotB) return { value: gotB, repaired: true, reason: '输出被截断，已补齐闭合括号' }

    // 候选 C：从尾部逐个砍掉不完整的片段，最多回溯 20 次
    let cut = s
    for (let n = 0; n < 20; n++) {
      const idx = cut.lastIndexOf(',')
      if (idx === -1) break
      cut = cut.slice(0, idx)
      const gotC = attempt(completeJson(cut))
      if (gotC) return { value: gotC, repaired: true, reason: `输出被截断，已回退 ${n + 1} 段` }
    }
  }
  return { value: null, repaired: false, reason: '输出里找不到可解析的 JSON' }
}

/**
 * 计费口径的人话说法。**不要说"免费"** ——
 * 见下面对 roster 那段注释：曾经所有成员都挂着 `free` 标签，
 * 而实测 qoder 每跑一次都在扣积分。
 */
const BILLING_LABEL = {
  subscription: '订阅内，调用不单独计费',
  credits: '按积分扣费，每次调用都消耗积分',
  tokens: '按 token 计费',
  unknown: '未知',
}

/**
 * @param {string} goal
 * @param {object[]} members 实测可用的成员
 * @param {string} [context]
 * @param {string[]} [roles] 用户在工作台上**指定**的分工（角色 label）。
 *   空数组 = 不指定，由规划者自己从目录里挑。
 */
export function buildPlannerPrompt(goal, members, context = '', roles = [], opts = {}) {
  /*
   * roster 里带上了**计费口径**。
   *
   * 为什么：这里曾经给每个成员标了 `free` 能力标签，而那个标签是错的 ——
   * 实测（2026-09-29）qoder 的 CLI 每次调用都在扣积分（一次短问答 0.1576 积分），
   * cursor/trae/doubao 也都走各自的付费通道。
   * 规划者看得见这些标签，于是会**为了省钱把活派给"免费"的成员** ——
   * 第三轮真跑里那个跑了 6.5 分钟的子任务就是这么落到 qoder 头上的。
   *
   * 现在只陈述事实（怎么扣费），并且明确告诉规划者别据此假设便宜。
   */
  const roster = members
    .map((a) => `- ${a.id}（${a.name}）：能力 [${(a.capabilities || []).join(', ') || '无'}]`
      + ` · 计费 [${BILLING_LABEL[a.billing] || '未知'}]`)
    .join('\n')

  /*
   * 角色清单由 `src/roles.js` 生成，**带上职责与交付物**。
   *
   * 原来这条只是一行"role 用中文短语，例如：A / B / C"。只说名字不说含义，
   * 规划者只能按字面猜 —— "评审"到底要不要改文件、"测试"交出来的是什么，
   * 全凭它自己发挥，于是拆出来的活没法验收（"写点测试"这种）。
   * 现在把「做什么 / 交出什么 / 需要什么能力」一起给它，派活才有依据。
   */
  const catalog = roleCatalogText()

  /*
   * 【指定分工】——用户在工作台上勾了具体角色时才有。
   *
   * 这里的措辞是**硬约束**（只能从这些里挑），因为勾选本身就是用户的决策：
   * 他勾了"代码主笔 + 评审 + 文档书写"，是想让这三件事都发生，
   * 而不是给规划者一个"参考建议"然后被无视。
   * 但**不限定步数**：一个角色可能确实需要两步（先写 A 再写 B），
   * 硬压成"每角色一步"会让拆分变得不自然。要求的是"每个角色至少被用一次"。
   */
  /*
   * ★ 两条"防截断"的上限，只对**会截断的那类规划者**成立。
   *
   * 实测事故（docs/05 第七节）：规划模型的输出写到一半被截断，后面的子任务整个丢掉，
   * 计划直接没法执行 —— 当时就是这么加的两条硬上限。但那是一次性吐出整段的模型的毛病：
   * 输出越长，被截断的概率越高。所以上限该跟着**规划者自己的能力**走，
   * 而不是变成一条对谁都适用的规矩。
   */
  const wide = !!opts.streamsOutput

  const rule5 = wide
    ? '子任务数量按工作量定，通常 3-10 个；每一步都要是一段能被独立验收的工作，不要为了凑数硬拆。'
    : '子任务数量控制在 2-6 个，不要过度拆分。'

  const rule7 = wide
    ? '每个子任务的 prompt 写清「做什么 + 交付什么 + 关键约束」——需要时把接口约定、'
      + '字段名、验收标准一起写进去（你不会被截断，不必为省字数牺牲清晰度）。'
      + '但不要复述总目标、不要贴大段参考代码。'
    : '**每个子任务的 prompt 控制在 150 字以内**：只写「做什么 + 交付什么 + 关键约束」，'
      + '不要复述总目标、不要铺陈背景、不要罗列长长的检查清单、不要把参考代码贴进来。'
      + '能一句话说清就不要写三句。'
      + '\n   ⚠️ 这一条是硬要求：实测规划输出有被**截断**的风险（连开两轮都遇到），'
      + '一旦截断就会丢掉后面的子任务、整个计划无法执行，而输出越短越安全。'
  const given = roles.length
    ? `\n【指定分工】（用户已选定，必须遵守）\n`
      + `${roles.map((r) => `- ${r}`).join('\n')}\n`
      + `★ 上面每个角色**至少**要出现在一个子任务里；role 字段必须**逐字**使用这些名字，`
      + `不要改写、不要翻译、不要发明别的角色。同一个角色可以拆成多步。\n`
    : ''

  return `你是一个任务规划者。请把下面的目标拆解成若干可执行的子任务。

【目标】
${goal}
${context ? `\n【背景资料】\n${context}\n` : ''}
【可用成员】（memberId 只能从下面选）
${roster}
${given}
【可用的角色】（role 字段只能从这些名字里选，逐字照抄）
${catalog}

【拆解要求】
1. 每个子任务只派给一个成员，写清"它要做什么"，指令要具体、可执行。
2. 有明显先后依赖的，用 dependsOn 表达；互相独立的不要加依赖（它们会被并行执行）。
3. 纯文字类工作（写文档、翻译、摘要）派给没有文件操作能力的成员。
   注意：**需要改磁盘上文件的角色，不能派给不操作本地文件的成员**（例如豆包）。
4. 需要读写代码或执行命令的，派给有 code / shell 能力的成员。
   上面每个角色标了「需要能力 / 会不会改文件」，派活时对着成员的能力标签核一遍。
5. ${rule5}
6. 「可用的角色」里每条都写了职责与交付物。选的角色要**真的对得上**这一步在做的事，
   并且把交付物写进 prompt —— 交付物是这一步的验收标准，不写就没人知道做到什么程度算完。
7. ${rule7}
8. 「计费」只说明**怎么扣费**，不代表便宜或贵。**不要**因为某项看起来"不单独计费"
   就把活优先派给它 —— 选人看能力匹配，不看计费口径。

【输出格式】
只输出一个 JSON 代码块，不要任何其他解释文字：
\`\`\`json
{
  "goal": "目标原文",
  "subtasks": [
    {
      "id": "s1",
      "title": "短标题",
      "memberId": "claude",
      "role": "代码主笔",
      "prompt": "给这个成员的完整指令",
      "dependsOn": []
    }
  ]
}
\`\`\``
}

/**
 * 调一个成员来生成计划
 * @returns {Promise<{plan:object|null, raw:string, cost:object, memberId:string, repaired:boolean, repairReason:string}>}
 */
export async function planWithMember(registry, goal, opts = {}) {
  const { memberId = 'claude', context = '', workdir } = opts
  const adapter = registry.get(memberId)
  if (!adapter) throw new Error(`找不到成员：${memberId}（规划者角色）`)

  /*
   * 用户指定的分工，**先过一遍目录**再交给规划者。
   *
   * 为什么要滤：不滤的话，前端送来的一个拼错的名字会被原样写进
   * 【指定分工】那句"role 字段必须逐字使用这些名字"，于是规划者被要求
   * 用一个**目录里不存在**的角色 —— 它要么照办（产出一个查不到预设的角色，
   * 落回 `rolePrompt()` 的兜底一句话），要么无视约束（那我们白写这段）。
   * 两种都不对，所以在这里就丢掉，并且**回执里说明丢了什么**，
   * 便于界面上提示"有 N 个角色名不认识，已忽略"而不是静默吞掉。
   */
  const want = Array.isArray(opts.roles) ? opts.roles.map((r) => String(r).trim()).filter(Boolean) : []
  const roles = want.filter((r) => ROLE_LABELS.includes(r))
  const droppedRoles = want.filter((r) => !ROLE_LABELS.includes(r))


  /*
   * 只把「实测可用」的成员交给规划者。
   *
   * 实测教训：某次拆解把两个子任务都派给了豆包 —— 因为豆包在 members.json 里是 enabled:true，
   * 但当时它的 API Key 没设，根本跑不起来。结果是**你先看到一份像模像样的计划，
   * 到执行阶段才挨个失败**。规划者看得见的名单，必须等于引擎真正能调动的名单。
   *
   * 探活用缓存（probeAll 不 force），所以这里几乎不花时间；真探不到就退回宽松名单，
   * 宁可让规划者多派几个人，也不要因为探活本身出问题而拆不出计划。
   */
  let usable = registry.list().filter((a) => a.isEnabled)
  try {
    const probed = opts.probed || (await registry.probeAll())
    const avail = usable.filter((a) => probed[a.id]?.available)
    if (avail.length) usable = avail
  } catch { /* 探活出问题不阻塞拆解 */ }

  const prompt = buildPlannerPrompt(goal, usable, context, roles, { streamsOutput: adapter.streamsStructuredOutput })

  const r = await adapter.run({
    prompt,
    workdir: workdir || process.cwd(),
    permission: 'readonly',
    timeoutMs: opts.timeoutMs,
  })

  // 用宽松版：输出被截断时也要尽量救出前面已写好的子任务（只要至少 1 个）
  const { value: plan, repaired, reason: repairReason } = extractJsonLoose(r.text, {
    minArrayField: 'subtasks',
    minItems: 1,
  })
  return {
    plan,
    raw: r.text,
    cost: r.cost || {},
    memberId,
    status: r.status,
    roster: usable.map((a) => a.id),
    roles,
    droppedRoles,
    repaired,
    repairReason,
  }
}
