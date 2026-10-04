# `judgeOutput()` 判定能力拆解 — 缺口清单

**基线**：`node tests/quality.test.mjs` → **11 通过 / 0 失败**（`process.exit(0)`）。样本 S2 实际长度 152 字符（`quality.js` 注释写的是 154，`tests/quality.test.mjs` 里的实际字符串为 152）。

---

## 0. 主流程图（决策顺序）

```
judgeOutput(text, meta)
├─ meta.status 存在且 !== 'ok'  → 直接返回 ok            ← 短路 #1
├─ t = (typeof text==='string' ? text.trim() : '')
├─ !t                            → suspect:empty          ← 空判定
├─ (刻意无「过短」判定)
├─ t.length <= 800 && 命中 REFUSAL_PATTERNS  → suspect:template-refusal   ← 先于 env
├─ t.length <= 400 && 命中 ENV_ERROR_PATTERNS → suspect:env-error
└─ 其余 → ok
```

**关键语义**：
- 长度用 `t.length`（trim 后的 UTF-16 code unit 数，CJK 每字算 1）。
- 两个长度阈值是 **`<=`（含边界）**：800 命中推诿、401 不再查 env。
- **顺序即优先级**：推诿先判、env 后判。短文本同时命中两类时只返回 `template-refusal`。
- `SHORT_TEXT_CHARS=400` 语义：**只有短产出才采信环境错误词**（规避长文引用误报）。
- `REFUSAL_MAX_CHARS=800` 语义：**只有短产出才判推诿**（长文正常讨论"请补充"不误伤）。
- 非 `string` 入参（`null`/`undefined`/`number`/对象）一律走 `t=''` → `empty`。即数字答案 `5` 若以 number 传入会被判空。

---

## 1. REFUSAL_PATTERNS（10 条，仅 `len<=800` 生效）

| # | 正则 | 匹配什么 | 触发/短路条件 | 已覆盖场景 | 绕过写法（不覆盖） |
|---|---|---|---|---|---|
| R1 | `/还没有具体(内容\|任务\|说明)/` | 简体"还没有具体内容/任务/说明" | 仅 ≤800 | 真实 S1（"还没有具体内容"） | 简体限定；`还没有具体的目标/需求/指令`；`还没有具体的 内容`（中间插字）；繁体`還沒有具體內容`；英文；`还没有任何内容`（"任何"插在中间） |
| R2 | `/没有(具体\|任何)?(的)?(任务)?内容/` | "没有[具体/任何][的][任务]内容" | 仅 ≤800 | 真实 S2（"没有具体的任务内容"） | `没有具体的目标/需求/说明/指令/上下文`；`未包含任何内容`；`内容缺失`；繁体`沒有內容` |
| R3 | `/请(补充\|提供\|把).{0,16}(目标\|内容\|需求\|说明\|信息\|指令\|约束)/` | "请补充/提供/把"后 16 字内出现目标类词 | 仅 ≤800 | "请补充…信息"（防误报用例里含此串） | **`请您补充目标`（"请"后必须紧跟动词，插"您"即失效）**；`麻烦补充`/`请告知`/`请说明`(无补充/提供/把)；间隔 >16 字；`请提供更多上下文`（"上下文"不在词表） |
| R4 | `/您(的)?消息(中\|里)?.{0,10}(是)?空/` | "您[的]消息[中/里]…空" | 仅 ≤800 | 间接（S2 靠 R6） | 用"你"而非"您"；`您发来的消息里是空的`（"您"与"消息"之间插字）；`您的消息为空`可中但 `您的消息没有内容`不中 |
| R5 | `/(我)?(没有\|未\|没)收到.{0,12}(内容\|指令\|任务\|需求\|具体)/` | "没/未收到"后 12 字内出现内容类词 | 仅 ≤800 | 无专门测试 | `没有看到任务`；`尚未接收到任务`（"接收"≠"收到"）；`没收到任何有效信息`（"信息"不在词表）；间隔 >12 字 |
| R6 | `/您的消息(中\|里)/` | 只要出现"您的消息中/里"（最宽松的推诿信号） | 仅 ≤800 | 真实 S2 | 用"你"；`您这条消息`；`您发送的消息里`；纯靠人称/措辞变化即可绕过 |
| R7 | `/please provide (more\|the\|your)/i` | 英文"please provide more/the/your" | 仅 ≤800，`i` | 无 | `Please share`/`Kindly provide`/`please provide details`（detail 不在备选）；大小写以外无变体覆盖 |
| R8 | `/no (specific )?(content\|task\|instructions\|requirements)/i` | 英文"no [specific] content/task/…" | 仅 ≤800，`i` | 无 | `no prompt`/`no goal`/`no user message`/`nothing to do`/`no question` |
| R9 | `/I (don't\|do not) see (any )?(content\|task\|instructions)/i` | 英文"I don't/do not see [any] content/task/instructions" | 仅 ≤800，`i` | 无 | `I can't see`/`I couldn't find`/`I don't see a goal/question`；`I'm not seeing` |
| R10 | `/there('s\| is) no (content\|task\|prompt)/i` | 英文"there's/is no content/task/prompt" | 仅 ≤800，`i` | 无 | `there's nothing`/`no question`/`no message`/`no input`；`there isn't any` |

**推诿类的结构性缺口（跨正则）**：

| 缺口 | 说明 |
|---|---|
| G-A 简体单语 | R1–R6 全部只认简体中文，繁体（`還沒有具體內容`）、日文/其他语种零覆盖 |
| G-B 依赖关键词 | R1/R2/R5 要"内容/任务/需求/说明/指令"类词；**无关键词的静默推诿**（`好的，我明白了。`、`请问您想让我做什么？`、`Understood. How can I help?`）一律判 ok |
| G-C 改一字即失效 | R3 的"请您补充"、R4/R6 的人称"你"、R5 的"接收到"——都是单字级绕过 |
| G-D 距离上限 | R3(≤16)、R4(≤10)、R5(≤12) 的 `.{0,N}` 有硬上限，加一句修饰语即失效 |
| G-E 占位符无覆盖 | `TODO`、`N/A`、`...`、`待补充`、`（此处省略）` 等占位式假成功不匹配任何推诿正则（且长度判定被刻意移除） |
| G-F 800 墙 | 长度 801+ 的推诿/占位文案直接跳过全部推诿检查（含纯空白前置、重复话术填充到 >800 的规避） |
| G-G 语义假成功 | `status:'ok'` + 非空 + 有长度但**内容全错/幻觉/答非所问**——本模块完全不判（属刻意设计边界） |

---

## 2. ENV_ERROR_PATTERNS（9 条，仅 `len<=400` 且未命中推诿时生效）

| # | 正则 | 匹配什么 | 触发/短路条件 | 已覆盖场景 | 绕过写法（不覆盖） |
|---|---|---|---|---|---|
| E1 | `/Not logged in/i` | 英文"Not logged in" | 仅 ≤400 | 有专门测试 | `not signed in`/`未登录`/`no credentials`/`authentication required` |
| E2 | `/Please run \/login/i` | "Please run /login" | 仅 ≤400 | 有测试（组合串） | `please run login`（无斜杠）；`run claude login`；`you must login`；`请先登录` |
| E3 | `/command not found/i` | bash "command not found" | 仅 ≤400 | 长文防误报用例中出现 | `not found: xxx`；`No such file or directory`；`executable file not found`；`ENOENT`（无 spawn 前缀） |
| E4 | `/不是内部或外部命令/` | cmd.exe 中文报错 | 仅 ≤400 | 无 | PowerShell 中文`无法将...识别为 cmdlet`；`不是内部命令`（截断）；英文环境 |
| E5 | `/is not recognized as an? (internal\|external)/i` | cmd 英文报错 | 仅 ≤400 | 无 | **PowerShell 主流措辞 `is not recognized as the name of a cmdlet` 直接绕过**（"as"后须紧跟 internal/external） |
| E6 | `/Workspace Trust Required/i` | VS Code/Cursor 目录未受信 | 仅 ≤400 | 有专门测试 | `Do you trust the authors`（无 "Required"）；`Workspace trust is disabled`；其他 IDE 措辞 |
| E7 | `/spawn .{0,40}ENOENT/i` | Node spawn ENOENT | 仅 ≤400 | 无 | 中间间隔 >40 字；`ENOENT` 单独出现（非 spawn 前缀）；`EACCES`/`ENOTFOUND` |
| E8 | `/permission denied/i` | Unix 权限 | 仅 ≤400 | 无 | Windows `Access is denied`/`拒绝访问`；`EACCES`；`not permitted` |
| E9 | `/unauthorized\|invalid api key\|401/i` | 鉴权失败/"401" | 仅 ≤400 | 无 | **过宽（假阳性）**：任何短文本含子串 `401` 即命中——答案 `401`、`line 401`、端口号、`401.` 都会被判 env-error；同时 `403`/`429 Too Many Requests`/`token expired`/`quota exceeded`/`rate limit` 不覆盖 |

**环境类的结构性缺口（跨正则）**：

| 缺口 | 说明 |
|---|---|
| G-H 400 墙 | 401–800 字长的环境错误 trace（常见：带堆栈的登录失败、`npm ERR!` 日志）不判 env-error；同时它 ≤800，仍会被推诿检查扫一遍（通常不命中）→ 最终 ok |
| G-I 中英/半全角 | E4 只认 cmd 中文、E5 只认 cmd 英文；`401`/`／`全角斜杠、`／login` 等变体不覆盖 |
| G-J 构建/测试失败类未覆盖 | `npm ERR!`、`error TS2304`、`Build failed`、`Exit code 1`、`fatal: not a git repository`、`Failed to compile` |
| G-K 网络/依赖类未覆盖 | `ECONNREFUSED`、`ETIMEDOUT`、`getaddrinfo ENOTFOUND`、`Could not resolve host`、`connection refused` |
| G-L 配额/限额类未覆盖 | `rate limit`、`429`、`quota exceeded`、`model overloaded`、`503 Service Unavailable`、`context length exceeded` |
| G-M 容器/守护进程类未覆盖 | `Cannot connect to the Docker daemon`、`docker: ...`（仅靠 E3 兜底） |
| G-N 超时未覆盖 | `Command timed out`（若 `meta.status` 仍报 ok 则完全漏判） |

---

## 3. empty 判定

| 规则 | 触发条件 | 已覆盖 | 不覆盖 |
|---|---|---|---|
| `!t` → `suspect:empty` | `text` 非 string → `t=''`；或 `text.trim()===''` | `''` 与 `'   '`（有测试，且断言 `codes===['empty']`） | 零宽字符 `\u200B`/`\u200D`（`trim()` 不去除）→ 判 ok；仅含换行的 `'\n\n'` 会被 trim 成空（可覆盖）；`text` 为 `0`/`false` 等 falsy 非串 → 归为 empty 而非"值" |

---

## 4. `meta.status !== 'ok'` 短路

| 规则 | 触发条件 | 已覆盖 | 不覆盖 |
|---|---|---|---|
| 早返回 `ok`（跳过一切检查） | `meta.status` 为**真值**且 `!== 'ok'` | `status:'failed'`（有测试，文本是真实推诿样本仍返回 ok） | **`meta.status='OK'` / `'Ok'` / `'success'` / `'completed'` / `'done'` 等一律短路为 ok**（大小写/词表敏感）；`meta` 缺省或 `status:undefined` 时**不短路**，会正常判定；`status:''`（空串为 falsy）也不短路 |

> 注意语义反直觉点：短路返回的是 `ok`（"不二次判定"），因此**任何非 `'ok'` 字面量状态值都会让文本完全不检查**——若上游把成功写成 `status:'success'`，产出即便为空/推诿也不会被标记（且此处 `empty` 检查也在短路之后）。

---

## 5. 测试文件：已断言 vs 未断言

**已断言（11 条）**
- R1/R2 的真实推诿样本 → `suspect` 且 `codes` **精确等于** `['template-refusal']`（S1 命中 R1/R2/R3 索引 `[0,1,2]`，S2 命中 `[1,2,3,5]`，实际取首个命中）。
- 3 个成功样本（含 1 字符 `'5'`）→ `ok`（防"过短误报"回归）。
- `''` 与 `'   '` → `empty`。
- `status:'failed'` → 短路 `ok`。
- env-error：E1（"Not logged in · Please run /login"）、E6（"Workspace Trust Required"）。
- 防误报：>400 字长文含 `not logged in`/`command not found` → ok；>800 字长文含 `请补充` → ok（隐含验证了 800 墙对 R3 生效）。

**未断言**
- 边界值：`length===400` / `401`、`length===800` / `801` 的分割点行为。
- E9 的 `401` 假阳性（如 `judgeOutput('401')`）。
- 状态值：`'OK'`/`'success'`/缺省 `meta`/空 `status` 的短路差异。
- 非 string 入参（`null`/`number`）。
- 零宽字符空串。
- 推诿 vs env 同时命中时的**优先级**（只返回 `template-refusal`）。
- R4/R5/R6 单独、R7–R10（英文推诿 4 条）全部未测。
- E3/E4/E5/E7/E8 单独未测；E5 的 PowerShell 绕过写法（实测 `is not recognized as the name of a cmdlet` 不命中）未做反例断言。
- 返回对象 `note` 文本、`describeQuality()` 渲染完全未测。
- 未断言"801+ 字的真实推诿句"（只测了长文中的普通引用），因此 800 墙的**漏报侧**无回归保护。