# `judgeOutput` 产出有效性判定 —— 缺口清单（s2 评审确认版）

**对象**：`src/engine/quality.js`（判定逻辑）、`tests/quality.test.mjs`（回归）、`src/engine/orchestrator.js:186`（唯一调用点）及三个适配器。
**现状**：判定只有三档——`empty`、`template-refusal`（10 条正则，仅 ≤800 字生效）、`env-error`（9 条正则，仅 ≤400 字生效）；`meta.status !== 'ok'` 时直接短路返回 ok。
**缺口口径**：「`status: 'ok'` 但产出不可用」却未被标记的情形（漏检）。另附 s2 核对出的反向问题（现有规则误报），见附录 A。
**核对方式**：静态正则推演（本会话 node 执行被权限拒绝，无法跑回归）；标注 ★ 的三条建议用真实样本回归确认。

---

## 一、假成功类

### G1 道歉 / 能力不足声明（cannot / unable / 无法 / 不能 / 对不起）
- **现象**：成员明确表态"做不到"，进程正常退出，`status: 'ok'`。
- **触发示例**：`抱歉，我无法访问你的本地文件系统，因此不能完成修改。` / `I cannot access your local file system, so I cannot complete the modification.` / `I'm unable to complete this task. Sorry!` / `我不能修改文件，因为这超出了我的权限范围。` / `对不起，我没有权限执行这个操作。`
- **为何识别不出**：`REFUSAL_PATTERNS`（quality.js:27-38）全部是「没收到指令 / 消息是空的」语义，与「收到了但做不到」是两类失败；中英文能力否定词一个都没有，`ENV_ERROR_PATTERNS`（:41-51）里也没有。
- **建议判定规则要点**：新增「能力否定」家族正则：中文 `(无法|不能|没办法|没法).{0,12}(访问|完成|执行|修改|读取|操作)`、`(抱歉|对不起)` 与能力/权限词同现；英文 `I (can'?t|cannot|am unable to|won'?t be able to)`、`I don'?t have (access|permission|the ability)`。限定短产出（沿用 ≤800 门），并要求主语为第一人称，避免误伤「这段代码不能为空」这类客观陈述。

### G2 承诺式占位（我将… / I will… / Sure, I can）
- **现象**：产出只有一句答应/计划，没有结果，`status: 'ok'`。
- **触发示例**：`好的，我将开始分析代码并修复该 bug。` / `I will now implement the fix.` / `Sure, I can help with that!`
- **为何识别不出**：`judgeOutput` 全函数（:67-103）没有任何未来时 / 承诺语气检测；这类文案非空、不含任何现有词表关键词，直接落到 `return ok`。
- **建议判定规则要点**：检测承诺起手式 `(我(将|会|马上)|\bI will\b|\bI'?ll\b|\bLet me\b|Sure, I can)`，结合「整段短且无产出信号（无代码块、无列表结果、结尾无标点）」再标 `suspect`；仅凭起手式单独命中会误伤长文档引用，建议加产出信号负条件。

### G3 usage / help 横幅
- **现象**：CLI 未正确收到参数，打印用法说明后以退出码 0 结束。
- **触发示例**：`Usage: claude [options] [prompt]` / `Missing required argument: prompt\nRun with --help for usage.`
- **为何识别不出**：`ENV_ERROR_PATTERNS`（:41-51）无 usage / help / missing argument 相关词。
- **建议判定规则要点**：补 `^\s*Usage:`、`Missing required argument`、`for usage`、`run with --help`；归入 env-error 家族，保留短产出前置条件。

### G4 占位符残留
- **现象**：产出里留着未填的模板占位符。
- **触发示例**：`已完成 {{module}} 的改造，TODO: <待补充>` / `已按 {目标} 完成修改，XXX 处细节待填。`
- **为何识别不出**：无任何占位符规则；而且「待补充」因缺前导「请」，连 :30 的 `请(补充|提供|把)…` 都不命中——现有规则对这类写法极其脆弱。
- **建议判定规则要点**：补 `\{\{?[^}\n]{1,20}\}?\}`（成对变量占位）、`<[^>\n]{1,12}(待|TODO|补充|填写)`、`\bTODO\b|\bFIXME\b|\bTBD\b`。注意排除文档里讲解模板语法的正常引用，保守做法是仅在短产出或占位符出现在结尾时标记。

### G5 通用异常堆栈
- **现象**：产出实为崩溃堆栈，被当成"分析结果"。
- **触发示例**：`TypeError: Cannot read properties of undefined (reading 'id')\n    at main (cli.js:12:19)` / `Traceback (most recent call last): … ValueError: invalid literal`
- **为何识别不出**：`ENV_ERROR_PATTERNS` 只收环境/凭据词，没有通用异常头或栈帧形态。
- **建议判定规则要点**：补异常头 `^(TypeError|ReferenceError|SyntaxError|RangeError)`、`Traceback \(most recent call last\)`、`panicked at|thread 'main' panicked`，以及栈帧行 `^\s+at .+:\d+:\d+`。可要求「以异常头开头 + 至少两行」以降低长文引用误报。

### G6 回显 prompt（echo 输入）
- **现象**：产出就是 prompt 原样吐回，说明指令没有被真正处理。
- **触发示例**：产出文本与本次 `prompt` 高度重合（归一去空白后相等或互为前缀）。
- **为何识别不出**：`judgeOutput` 签名只有 `(text, meta)`（:67），拿不到 prompt；但 `prompt` 就在调用点作用域内（orchestrator.js:163 生成、:187 已使用）——传参一行即可。
- **建议判定规则要点**：`judgeOutput(r.text, { status: r.status, prompt })`；判定产出与 prompt 归一化相似度，命中即 `suspect`，建议 code `echo`。

### G7 声称已改动，但 `changedFiles` 为空
- **现象**：产出写"已修改 / 已修复某文件"，而本次调用没有任何文件变更。
- **触发示例**：产出含 `已修复 src/engine/quality.js 中的 401 判定。`，而 `changedFiles: []`。
- **为何识别不出**：`changedFiles` 在 orchestrator.js:189 写进 entry，却没有传给 quality（:186 只传 `r.text` 与 `status`），judge 无从知道改没改。
- **建议判定规则要点**：`judgeOutput(r.text, { status, changedFiles })`；文本命中完成语（`已(修改|修复|新增|删除|写入|重构)`）且 `changedFiles.length === 0`、且权限档不是只读（plan/分析档允许只出结论）时标 `suspect`，建议 code `claimed-edit-no-change`。

### G8 身份声明
- **现象**：产出是"我是 XX 助手"式自我介绍，没有任务结果。
- **触发示例**：`我是一个由 Claude 驱动的 CLI 助手，我可以帮你完成编程任务。` / `As an AI language model, I don't have access to your local files.` / `作为 AI 我无法在您的机器上运行代码。`
- **为何识别不出**：现有 :36 是 `I (don't|do not) see …`，与样本里的 `I don't have access` 一字之差（see / have），不命中；中文身份声明更是零覆盖。
- **建议判定规则要点**：补 `As an (AI|artificial intelligence)|I am an AI|language model`、`我是(一个)?(由|基于)?.{0,12}(AI|助手|模型)`、`作为 ?AI`；与 G1 合并为「AI 自我声明」子类。

### G9 截断（写到一半）
- **现象**：产出被中途截断（token 上限或流程中断），语义不完整。
- **触发示例**：结尾是省略号收尾 `分析结果如下：… 3. 最后……`；或未闭合的 ``` 代码围栏。
- **为何识别不出**：无任何结构完整性检测。
- **建议判定规则要点**：结构校验——统计 ``` 出现次数是否为偶数、结尾是否以省略号/「以下省略」/悬空列表项收尾；若适配器能取到 `finish_reason === 'length'` 则直接采信。建议作为最后兜底、以低优先 code `truncated` 输出。

### 补入项：上游信号已被丢掉（非纯正则问题，需先修上游）
- **G-A1 `is_error` 被忽略（claude 适配器）**：`--output-format json` 的返回里带 `is_error: true`（如 `error_max_turns`）时，claude.js:96/:99 只看 `exitCode === 0` 便置 `status: 'ok'`，quality 因 `status === 'ok'` 继续判定，而文本「已达到最大轮次」不含任何现有词 → 判 ok。样本：`{"type":"result","subtype":"error_max_turns","is_error":true,"result":"已达到最大轮次"}`、`{"type":"error","error":{"type":"api_error","message":"Internal server error"}}`。**建议**：适配器层 `if (payload.is_error) result.status = 'failed'`（或把 `is_error` 透传给 quality）。属上游一行修复，优先于扩正则。
- **G-A2 结构化信号 `permission_denials` 未读**：真实运行 `.agenthub/runs/run-1790658473692.json` 的 claude s1/s2/s3 三条产出（475 / 587 / 1027 字）自称"测试文件已写好，但命令被 `This command requires approval` 拦截、未真正执行"，`status` 全为 ok，judge 全判 ok；整次 run 报「3/3 成功」。`raw.stdout` 里已有 `permission_denials[]`，但判定只看 `text`。**建议**：把 `permission_denials` 透传给 judge，非空且产出未含实测输出时标 `suspect`，code 建议 `not-executed`。

---

## 二、环境错误类

### E1 stderr 双重丢弃
- **现象**：真正说明失败的环境报错根本没进入判定视野。
- **触发示例**：任何把错误写进 stderr 却仍以退出码 0 结束的 CLI 调用（stderr 里是登录失败、网络失败等）。
- **为何识别不出**：不止是 quality 不收 stderr——适配器也只在 `exitCode !== 0` 时才把 stderr 并进 text（generic.js:145-150、claude.js:103-108）。exit-0 的假成功场景里，stderr 留在 `raw.stderr`，而 orchestrator.js:186 只传 `r.text`、不传 `raw`——**双重丢弃**；quality 也拿不到 raw。
- **建议判定规则要点**：① 调用点改为 `judgeOutput(r.text, { status, stderr: r.raw?.stderr })`（或在判定前把 stderr 并入待检文本）；② 明确策略：**ok 且 stderr 非空时，对 stderr 单独跑环境规则，命中即 `suspect`**。只改传参一行不够，必须先把"ok 时 stderr 是否参与判定"定下来。

### E2 限流 / 配额 / 计费
- **现象**：429、配额耗尽、欠费等响应被当作正常产出。
- **触发示例**：`API Error: 429 rate_limit_error. Please retry after 30s.` / `You have exceeded your token quota. Please upgrade your plan.` / `Overloaded. Please reduce prompt length or try again later.` / `Your credit balance is too low to access the API.`
- **为何识别不出**：`ENV_ERROR_PATTERNS` 只有 `401`（:50），无 429 / quota / rate limit / billing / overloaded。
- **建议判定规则要点**：补服务端错误族 `internal_server_error|api_error|error_ver|overloaded|529|503`；配额族 `rate[ _-]?limit|too many requests|429|quota|credit balance|insufficient (funds|balance)`；会话过期 `login expired|session expired|token expired`（现有仅 `Not logged in`）。

### E3 网络 / DNS / 连接 / 证书
- **现象**：连不上服务端，产出只有网络错误文本。
- **触发示例**：`Error: getaddrinfo ENOTFOUND api.anthropic.com` / `Error: connect ECONNREFUSED 127.0.0.1:8080` / `fetch failed: network error` / `Error: tunneling socket could not be established` / `self-signed certificate in certificate chain`
- **为何识别不出**：现有 :48 的 `spawn .{0,40}ENOENT` ≠ `ENOTFOUND`；`ECONNREFUSED / ECONNRESET / ETIMEDOUT / socket hang up` 与证书类全无。
- **建议判定规则要点**：补 `ENOTFOUND|EAI_AGAIN|getaddrinfo`、`ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE`、`fetch failed|socket hang up|network error|Could not resolve host`、`tunneling socket`、`certificate|self-signed|unable to verify`。

### 补充：环境错误文案变体
- Windows PowerShell：`无法将…项识别为 cmdlet`（现只覆盖 cmd.exe 的「不是内部或外部命令」，quality.js:44；适配器走 shell，两种都可能出现）
- 中文系统错误：`拒绝访问`、`系统找不到指定的路径`
- 资源类：`heap out of memory`；文件类：`no such file or directory`（现只有 `spawn…ENOENT` 一种形态）

### 环境类中已核对为「非缺口」的两项（避免重复投入）
- **超时文本**：三个适配器超时都置 `status: 'timeout'`（generic.js:122-126、claude.js:73-77、doubao.js:192-195），quality.js:71 早退，已被覆盖；仅「退出码 0 但 stdout 里残留 Request timed out」是窄边缘。
- **REST 成员（豆包）HTTP 错误**：错误路径 `status` 保持 `'failed'`（doubao.js:225），不会以 ok 身份进入 quality；quality 的 env-error 规则实际只服务 CLI 成员。

---

## 三、推诿类

### R1 / R2 能力否定与道歉（与 G1 同族，此处不重复展开）
- 对应样本 `我不能修改文件，因为这超出了我的权限范围。`、`对不起，我没有权限执行这个操作。` / `I'm sorry, but I can't help with that request.`；根因与建议同 G1。

### R3 策略性拒绝
- **现象**：以"超出权限 / 安全限制 / 不能协助此类请求"为由拒绝执行。
- **触发示例**：`I'm sorry, but I can't help with that request.` / 以安全策略/使用政策为由的拒绝文案。
- **为何识别不出**：REFUSAL 词表只描述「消息是空的」，不含拒绝语义。
- **建议判定规则要点**：与 G1 合并处理，补 `I (can'?t|cannot) help with|not able to assist|out of (my )?scope|usage polic`、`超出(我的)?(权限|范围)|无法协助`。

### R4 澄清问句
- **现象**：成员反问用户"你指的是哪个"，而不是给结果。
- **触发示例**：`请问您指的是哪个模块？` / `Could you clarify what you mean?` / `Do you mean option A or option B?`
- **为何识别不出**：现有 REFUSAL 只认"消息里是空的 / 没有收到内容"；:33 的 `您的消息(中|里)` 还强制要求出现"消息"二字，反问句完全落空。
- **建议判定规则要点**：补中文 `请问|请告知|请明确|请确认|请说明|您想让我` 且以 `？/?` 收尾；英文 `Could you clarify|Which (file|module|one) do you mean|Do you mean|What exactly do you want`。

### R6 "请告诉我 / 我需要更多信息"家族
- **现象**：以"请告诉我目标"收尾的伪澄清，常与 G2 承诺式同时出现。
- **触发示例**：`当然可以！请告诉我您想实现什么功能。` / `请说明您的需求。` / `Please confirm which file to change.` / `I need more details.`
- **为何识别不出**：:30 的动词白名单只有 `补充|提供|把` 三个，「请告诉我 / 请说明 / 请确认 / 请展示」一律不命中。
- **建议判定规则要点**：扩动词白名单 `补充|提供|把|告诉|说明|明确|确认|展示|给出|发`；补 `我需要更多(信息|上下文|细节)`、`需要您(确认|提供)`、`您想让我(做|实现)什么`；英文补 `Please (confirm|clarify|share|tell)|I need more (details|context)|What would you like me to do`。

### 推诿类的跨规则结构性缺口
| 缺口 | 说明 |
|---|---|
| 简体单语 | R1–R6 只认简体，繁体 `您這條消息還沒有具體內容，請補充說明。` 与日文/其他语种零覆盖 ★ |
| 无关键词静默推诿 | `好的，我明白了。` / `请问您想让我做什么？` / `Understood. How can I help?`——不含"内容/任务/需求"类词，全部判 ok |
| 单字级绕过 | `请您补充目标`（"请"后插"您"即失效）、用"你"代替"您"、`接收到任务`（≠"收到"） |
| 距离上限 | :30 `.{0,16}`、:33 `.{0,10}`、:32 `.{0,12}` 都有硬上限，加一句修饰语即失效 |
| 长度墙 | 801 字以上的推诿/占位会跳过全部推诿检查（重复话术填充即可规避），见附录 A 的 C1 |

### 三、已核对为「非缺口」的 s1 误判
- **R5（请手动执行 / 建议联系管理员 / 请提供 API key）**：s1 判为漏检，核对后**英文变体已被覆盖**——`Please provide your API key.` 命中 :34 `/please provide (more|the|your)/i`。仅中文「请提供你的 API key」因"API key"不在 :30 的词表内仍不命中，并入 R6 的扩词表处理即可，无需单列规则。

---

## 附录 A：反向缺口——现有 4 条规则会误报

模块自述原则是「宁漏勿误、不喊狼来了」（quality.js:15-21），但这 4 条规则过宽，扩词表前必须先收窄，否则误报面会同步放大。

| 编号 | 位置 | 触发示例 | 问题 |
|---|---|---|---|
| OV1 | :50 `/401/` | `编号 4012 的工单已处理完毕。` | 无词边界，任何短文本含子串 `401`（4012、L401、端口号）即判 env-error ★ |
| OV2 | :33 `/您的消息(中\|里)/` | `您的消息中提到的需求我已完成分析，结论如下：…` | 无语义约束，正常承接句即判 template-refusal ★ |
| OV3 | :29 `/没有(具体\|任何)?(的)?(任务)?内容/` | `检查发现该配置文件没有内容部分，属于正常现象。` | "没有…内容"被当作推诿，与"文件为空"的事实陈述混淆 |
| OV4 | :35 `/no (specific )?(content\|task\|instructions\|requirements)/i` | `The generated file has no content, so the test suite skipped it.` | 英文正常分析句被判推诿 ★ |

**佐证**：`tests/quality.test.mjs:80-90` 只防了「长文里引用这些措辞」，没有防「短文里的合法引用」——而 400 / 800 阈值之内的短合法产出恰是最易误伤区。修法要点：`\b401\b` 加词边界；:29 / :33 / :35 加语义约束（如要求第一人称主语、要求"没有内容"指向"您的消息"而非文件本身）。

---

## 附录 B：修正后的优先级

1. **E1 + G-A1**（stderr 传参 + claude `is_error` 检查）——信号在 quality 上一层就丢了，先修上游。
2. **OV1–OV4 误报修复**——扩规则前先堵误报，否则标记会失去公信力。
3. **G1/G2 + R1/R2/R3/R6**（cannot / apology / promise / 请告诉我 家族）——覆盖最典型的假成功与推诿。
4. **G6/G7 + 调用点一行传参**（prompt、changedFiles、cost 均已在 orchestrator.js:163-191 作用域内）。
5. **C1（长度墙长文包裹）记为已知盲区**；**C2（繁简）视成员构成决定是否处理**。

---

## 附注
- 本次核对为**静态正则推演**（本会话 node 执行被权限拒绝，未能跑回归脚本）；标注 ★ 的三项——R5 英文已覆盖、OV1–OV4 误报、C2 繁体零覆盖——建议用真实样本回归确认。
- 遗留临时文件 `D:\app\AgentHub\.agenthub\verify-quality-gaps.mjs`（s1 的样本运行脚本），可手动删除。