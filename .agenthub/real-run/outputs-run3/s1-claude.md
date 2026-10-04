# 结论先行

**现状**：`judgeOutput`（`src/engine/quality.js:67`）只有 **3 条判定**，全部是**短文本上的关键词模板匹配**：
1. `empty` — 空/空白（`quality.js:74`，无长度门槛）
2. `template-refusal` — 命中 10 条「索要输入」模板，仅当 `≤800` 字符（`quality.js:27-38, 80-89`）
3. `env-error` — 命中 9 条环境/凭据词，仅当 `≤400` 字符（`quality.js:41-51, 91-100`）

`meta.status !== 'ok'` 直接放行（`quality.js:71`）；**刻意不做长度判定**（`quality.js:76-78`）。判定纯看 `text` 字符串，**不看 prompt、不看 stderr、不看 changedFiles**（调用点 `src/engine/orchestrator.js:186` 只传 `r.text` 和 `status`）。

**核心结论**：当前覆盖的是「**prompt 根本没送到 → 回一句‘请补充内容’**」这**一个**真实事故场景。三大类里识别不出来的缺口，**根因可归为 4 个**：(a) 关键词白名单太窄，只覆盖「索要输入」不覆盖「拒绝执行」；(b) 长度门槛（400/800）系统性放过长推诿/长环境错误；(c) 只看 `text` 单一输入，丢掉 stderr / prompt / changedFiles 等可用信号；(d) 完全没有「语义/一致性」判定（echo 回显、占位符、承诺语、堆栈）。

测试文件（`tests/quality.test.mjs`）只有 2 条真实失败样本 + 2 条真实成功样本 + 4 条边界，**没有任何一条覆盖下述缺口** —— 所以这些缺口大概率连"已知未知"都算不上。

---

# 一、假成功（进程 ok、产出却是废的）

| # | 缺口 | 触发示例 | 判断依据（为何现在漏） | 置信度 |
|---|---|---|---|---|
| G1 | **道歉/能力不足型拒答**（"I cannot / 我无法"） | `抱歉，我无法访问你的本地文件系统，因此不能完成修改。` | 10 条 REFUSAL 全是「索要输入」语义（`quality.js:27-37`），**没有一条覆盖 cannot/unable/做不到**。这正是最典型的"假成功" | 高 |
| G2 | **承诺式占位**（未来时/仅表态） | `好的，我将开始分析代码并修复该 bug。` / `I will now implement the fix.` | 无任何「承诺/未来时」检测。文本非空、非模板、≤800 也只当普通短文放行 | 高 |
| G3 | **CLI 帮助/用法横幅** | `Usage: claude [options] [prompt]`、`Options: -p, --print ...` | ENV 列表无 usage/help/banner 类（`quality.js:41-51`） | 高 |
| G4 | **未替换的占位符/模板残留** | `已完成 {{module}} 的改造，TODO: <待补充>` | 无占位符检测（`{{}}`、`<TODO>`、`XXX`、`[待填写]`、`{目标}`） | 高 |
| G5 | **错误堆栈但非"环境词"** | `TypeError: Cannot read properties of undefined (reading 'id')`（进程可能 exit 0） | ENV 列表只列环境/凭据词，**无通用异常栈**（TypeError/Traceback/panic） | 高 |
| G6 | **echo 回显输入**（产出 == prompt） | 成员把 prompt 原文回显当作"结果" | `judgeOutput` 签名拿不到 prompt（`quality.js:67`），无法比对 | 高 |
| G7 | **声称改动但零改动** | 文本 `已修复全部问题`，而 `changedFiles: []` | 调用点不把 `changedFiles` 传给 quality（`orchestrator.js:186`）；函数也无此参数 | 中 |
| G8 | **身份/元话语开头** | `我是一个由 Claude 驱动的 CLI 助手，我可以帮你...` | 无身份声明检测（"As an AI" 类） | 中 |
| G9 | **截断的产出** | 结尾是 `...` 或未闭合 ``` 代码块（maxTokens 截断） | 无结构化截断/未闭合检测 | 中 |

# 二、环境错误

| # | 缺口 | 触发示例 | 判断依据 | 置信度 |
|---|---|---|---|---|
| E1 | **stderr 被整个丢弃** | `stdout="处理完成"`（短），`stderr="Error: getaddrinfo ENOTFOUND api.anthropic.com"` | 适配器把 stderr 放 `raw.stderr`（`src/adapters/base.js:36`），但 `orchestrator.js:186` 只传 `r.text`；quality 无 stderr 入参。**stderr 里的环境错误永远不会被看见** | 高 |
| E2 | **限流/配额/计费** | `API Error: 429 rate_limit_error`、`You've hit your usage limit`、`insufficient credit`、`402` | 列表显式写了 `401` 却无 `429`/quota/billing/credit（`quality.js:50`） | 高 |
| E3 | **网络/DNS/TLS** | `FetchError: ... reason: ECONNREFUSED`、`ENOTFOUND`、`ECONNRESET`、`self signed certificate` | 无任何网络栈错误词 | 高 |
| E4 | **超时** | `Request timed out`、`ETIMEDOUT`、`context deadline exceeded` | 有 `ENOENT` 却无 `ETIMEDOUT`/timeout（`quality.js:48`） | 高 |
| E5 | **上下文超限** | `prompt is too long: 250000 tokens > 200000`、`context length exceeded` | 无 | 高 |
| E6 | **fs 层 ENOENT（非 spawn）** | `Error: ENOENT: no such file or directory, open 'D:\\app\\AgentHub\\out.txt'` | 正则锚定 `spawn .{0,40}ENOENT`（`quality.js:48`），**fs ENOENT 不匹配** | 高 |
| E7 | **登录态过期但换词** | `Authentication failed: token expired, please re-authenticate`、`invalid_grant` | 只覆盖 `Not logged in` / `Please run /login` / `unauthorized\|invalid api key\|401`（`quality.js:42-50`） | 高 |
| E8 | **供应商/模型侧错误** | `overloaded_error`、`529`、`503`、`model not found` | 无 | 中 |
| E9 | **EPERM/EACCES 的另一种写法** | `EPERM: operation not permitted` | 有 `permission denied`（`quality.js:49`）但不含 `operation not permitted` / `EPERM` | 中 |
| E10 | **未安装/无此子命令** | `unknown command "run"`、`unrecognized option` | 只覆盖 `command not found` / not recognized as internal/external（`quality.js:44-46`） | 中 |

# 三、推诿文案

| # | 缺口 | 触发示例 | 判断依据 | 置信度 |
|---|---|---|---|---|
| R1 | **拒绝执行（中文）** | `抱歉，我无法直接执行命令，请你自己运行。`、`这超出我的能力范围` | REFUSAL 只匹配「索要输入」（请补充/提供/把…），**无 无法/不能/做不到/不便** 家族（`quality.js:28-32`） | 高 |
| R2 | **拒绝执行（英文）** | `I'm sorry, but I can't help with that.`、`I'm unable to complete this.` | 英文 3 条全是 `please provide (more\|the\|your)` / `no content...` / `there's no content`（`quality.js:34-37`），**不含 cannot/unable/decline** | 高 |
| R3 | **安全/合规拒绝** | `出于安全考虑我无法协助该项操作。`、`this request violates our policy` | 无 | 高 |
| R4 | **追问澄清（询问式，非"请补充X"）** | `请问您指的是哪个模块？`、`Could you clarify what you mean?`、`Do you mean A or B?` | 白名单要求紧跟「目标/内容/需求…」名词（`quality.js:30`），`请(告诉我\|clarify\|确认)` 不命中 | 高 |
| R5 | **踢回人工/要凭据** | `请手动执行以下命令`、`建议联系管理员`、`请提供你的 API key` | 无 | 中 |
| R6 | **"当然可以"+空承诺** | `当然可以！请告诉我您想实现什么功能。` | `请告诉我` 不在 `请(补充\|提供\|把)` 之列（`quality.js:30`） | 中 |
| R7 | **能力受限推诿** | `作为 AI 我无法在您的机器上运行代码。` | 无 | 中 |

# 四、跨类系统性缺口（设计取舍导致）

| # | 缺口 | 说明 | 判断依据 |
|---|---|---|---|
| C1 | **长度门槛系统性漏报** | 推诿只在 `≤800` 判、环境只在 `≤400` 判（`quality.js:54,60`）。**长礼貌拒绝**（带"我能做什么"清单）和**带 usage 的长错误页**必然漏 | 阈值是硬 `if`，超一点即放行 |
| C2 | **繁简/全角/emoji 变体** | `還沒有具體內容`（繁体）、带 emoji 包裹的错误横幅 | 正则字面量是简体，无规范化预处理 |
| C3 | **无一致性/期望值比对** | s2 返回 `bravo` 而期望链是别的值 → 无从判 | quality 不看依赖产出、不看 expected（`quality.js:67` 入参只有 text+meta） |
| C4 | **0 消耗却报成功** | cost/token 为 0 但 status ok | meta 不传 cost；quality 无该维度 |
| C5 | **测试零覆盖上述缺口** | `tests/quality.test.mjs` 仅 2 个真实失败样本（`refusal`）+ 4 条边界，**没有 cannot/apology/429/stderr/占位符/承诺语任一用例** | 见测试文件全文 |

---

# 建议优先级（供下一步）

1. **E1（stderr 不进 quality）** —— 改一行传参即可捞回大量环境错误，投入产出最高。
2. **G1/G2 + R1/R2（cannot/apology/promise 家族）** —— 扩白名单，覆盖最典型的"假成功"。
3. **R4/G4（澄清问句、占位符残留）** —— 纯正则补充，低成本。
4. **C1（阈值换"外部信号优先"逻辑）** —— 结构性问题，需设计；当前"宁漏勿误"取舍可保留但应识别为已知盲区。

**不确定性**：以上触发示例的"真实出现频率"未经真实运行数据核实（`trajectories/`、`.agenthub/runs` 未逐条统计）；正则建议措辞需在真实样本上回归验证，避免把长文档正例误伤（现有回归点见 `tests/quality.test.mjs:80-90`）。

**来源**：`src/engine/quality.js`（全文）、`tests/quality.test.mjs`（全文）、`src/engine/orchestrator.js:186`、`src/adapters/base.js:36`、`src/engine/trace.js:40-85`、`mcp-server/index.js:176`。