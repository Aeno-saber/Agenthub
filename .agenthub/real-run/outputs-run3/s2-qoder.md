核对完成。以下为评审结论。

---

# 确认后的缺口清单（s2 · 评审）

**核对方法**：重读 `quality.js` 全文、唯一调用点 `orchestrator.js:186`、三个适配器（claude/generic/doubao）、`exec.js`、测试全文；s1 每条触发样本对 19 条正则逐条手工推演（本会话 bash/node 执行被拒，无法跑回归脚本，结论均为静态推演，正则均为简单字面量，可靠；建议后续用真实样本回归其中标注项）。

**总判定**：s1 清单基本成立——**24 条里 21 条确认为真缺口，1 条判错（R5 英文变体其实已覆盖），2 条需修正表述**。另补入 **2 条上游适配器缺口、10+ 条文案变体、4 条 s1 完全没看的反向缺口（现有规则误报）**。

## 一、假成功类（G1–G9）：全部真缺口

| # | 核对结论 | 判定位置 |
|---|---|---|
| G1 道歉/无法（cannot/unable/无法/不能/对不起） | **真缺口**。3 个中英样本 0 命中：REFUSAL 全是「没收到指令」语义 | quality.js:27-38 |
| G2 承诺式（我将…/I will…/Sure, I can） | **真缺口**。无任何未来时/承诺检测 | quality.js:67-103 全函数 |
| G3 usage/help 横幅 | **真缺口**。ENV 列表无 usage/help/missing argument | quality.js:41-51 |
| G4 占位符（`{{}}`/`<待补充>`/XXX） | **真缺口**。且「待补充」因缺前导「请」连 pattern 3 都不命中——规则极脆弱 | quality.js:30 |
| G5 通用堆栈（TypeError/Traceback/panic） | **真缺口**。ENV 只有环境/凭据词 | quality.js:41-51 |
| G6 echo 回显 prompt | **真缺口**。函数签名无 prompt；但 `prompt` 就在调用点作用域内（orchestrator.js:163,187）——**一行可修** | orchestrator.js:186 |
| G7 声称改动但 changedFiles 空 | **真缺口**。`changedFiles` 写进 entry（:189）却不传 quality | orchestrator.js:186,189 |
| G8 身份声明（我是一个…助手/As an AI） | **真缺口**。注意 `I don't have access` 与已有 `I don't see`（:36）一字之差，不命中 | quality.js:35-36 |
| G9 截断（结尾省略号/未闭合 ```） | **真缺口**。无结构检测 | quality.js:67-103 |

## 二、环境错误类：E1 成立且**比 s1 说的更严重**，其余真缺口

| # | 核对结论 | 判定位置 |
|---|---|---|
| E1 stderr 丢弃 | **真缺口（表述需修正）**。不止是 quality 不收 stderr：适配器只在 `exitCode !== 0` 时才把 stderr 并进 text（generic.js:145-150、claude.js:103-108）。**exit-0 的假成功场景里 stderr 恰好被丢在 `raw.stderr`，orchestrator.js:186 又不传 raw**——双重丢弃。修一行传参不够，还得定「ok 时 stderr 是否并入判定」 | generic.js:145, claude.js:103, orchestrator.js:186, quality.js:67 |
| E2 限流/配额/计费 | **真缺口**。只有 `401`，无 429/quota/rate limit/billing/overloaded | quality.js:50 |
| E3 网络（ENOTFOUND/ECONNREFUSED/fetch failed） | **真缺口**。`spawn…ENOENT` ≠ ENOTFOUND；ECONNRESET/ETIMEDOUT/socket hang up 全无 | quality.js:48 |
| 超时文本 | **大半已覆盖（修正 s1 隐含假设）**：三个适配器超时都置 `status:'timeout'`（generic.js:122-126、claude.js:73-77、doubao.js:192-195）→ quality.js:71 早退。仅「exit-0 但 stdout 里残留 Request timed out」为窄边缘 | quality.js:71 |
| REST 成员（豆包）HTTP 错误 | **已覆盖（适配器层）**：错误路径 status 保持 'failed'（doubao.js:225）→ 不会以 ok 身份进 quality。quality 的 env-error 实际只服务 CLI 成员 | doubao.js:225 |

## 三、推诿类：R5 判错，其余真缺口

| # | 核对结论 | 判定位置 |
|---|---|---|
| R1/R2 cannot/apology（=G1 家族） | **真缺口** | quality.js:27-38 |
| R3 策略拒绝 | **真缺口** | 同上 |
| R4 澄清问句 | **真缺口**。「请问您指的是…」「Could you clarify」均 0 命中 | quality.js:30 |
| R5 踢回人工/要凭据 | **部分已覆盖（s1 判错）**：中文「请提供你的 API key」不命中（「API key」不在名词表内）；但英文 **"Please provide your API key" 命中 quality.js:34** `/please provide (more|the|your)/i` → template-refusal。类别错位但 level=suspect 已达到目的 | quality.js:34 |
| R6 「请告诉我…」 | **真缺口**。动词白名单只有 补充\|提供\|把 | quality.js:30 |
| R7 能力受限（作为 AI 我无法…） | **真缺口** | quality.js:27-38 |

## 四、跨类 C1–C5：全部真缺口

- **C1 长度门槛**：真缺口，结构性。硬 `if`（quality.js:80 `≤800`、:91 `≤400`），同一句「Not logged in」从 30 字符拉长到 410 字符即翻转为 ok。属「宁漏勿误」的已知取舍，应记为**已知盲区**而非 bug。
- **C2 繁简**：真缺口。「您這條消息還沒有具體內容」逐字不命中简体字面量（還≠还、內≠内、請≠请）。
- **C3 一致性比对**：真缺口（结构性，quality 无该维度）。
- **C4 零消耗**：真缺口。`r.cost` 在调用点作用域内（orchestrator.js:188）却不传——**一行可修**。
- **C5 测试零覆盖**：属实。tests/quality.test.mjs 全文 11 例，无一覆盖上述任一缺口。

## 五、s1 漏掉的缺口（本次补入）

**A. 上游适配器层（比 quality.js 更早丢信号）**
- **A1** claude.js:86-96：解析 `--output-format json` 后**忽略 `payload.is_error` 与 `subtype`**（如 `error_max_turns`）。CLI 退出 0 + `is_error:true` 时，text 取 `payload.result`（可能是一句正常口吻的道歉）、status 仍 'ok'——最丰富的错误信号在 quality 上一层就被扔掉。
- **A2** claude.js:87-89 `payload.result ?? payload.text ?? raw`、doubao.js:209-214 `msg?.content ?? r.raw`：JSON 字段缺失时**整个 raw JSON 壳成为 text** 且 status ok，quality 无「纯 JSON 壳」检测。

**B. 环境错误变体（ENV 列表补充）**
- 证书/代理：`self-signed certificate`、`unable to verify the first certificate`、`tunneling socket`（企业代理常见）
- 服务端：`internal_server_error`、`overloaded`、`api_error`、`529`
- 配额族：`rate limit`、`too many requests`、`quota`、`credit balance`
- 会话过期：`login expired`、`session expired`、`token expired`（现只有 Not logged in）
- **Windows PowerShell 变体**：「无法将…项识别为 cmdlet」（现只覆盖 cmd.exe 的「不是内部或外部命令」，quality.js:44——适配器走 shell 两者都可能出现）
- 中文系统错误：「拒绝访问」「系统找不到指定的路径」
- 资源：`heap out of memory`；文件：`no such file or directory`（现只有 spawn…ENOENT 形态）

**C. 推诿变体（REFUSAL 补充）**
- 中文：请告诉我/请说明/请明确/请确认/请展示（动词白名单仅 3 个）；「我需要更多信息」「需要您确认」「您想让我做什么？」
- 英文：`Could you clarify`、`What exactly do you want`、`Which file do you mean`、`I need more details/context`、`Please confirm`、`What would you like me to do`（CLI 包装层 prompt 未送达时的高频形态）

**D. 反向缺口：现有 4 条规则会误报（s1 完全没看这一面，而模块自己的原则是「不喊狼来了」）**
- **OV1** quality.js:50 `/401/` 无词边界 → 短产出含「4012」「L401」即判 env-error
- **OV2** quality.js:33 `/您的消息(中|里)/` 无语义约束 → 「您的消息中提到的需求我已完成分析」判 template-refusal
- **OV3** quality.js:29 `没有…内容` → 「该配置文件没有内容部分，属正常现象」误报
- **OV4** quality.js:35 `no content` → 「The generated file has no content」（测试成员的正常分析）误报
- 佐证：tests/quality.test.mjs:80-90 只防了「长文引用」，没防「短文合法引用」——400/800 阈值内的短合法产出恰是最易误伤区。**扩白名单若不先修 OV1–OV4，会把误报面同步放大。**

## 六、修正后的优先级

1. **E1+A1**（stderr 传参 + claude `is_error` 检查）——信号在 quality 上一层就丢了，先修上游
2. **OV1–OV4 误报修复**（`\b401\b`、收窄 :29/:33/:35）——扩规则前先堵误报，否则标记失去公信力
3. **G1/G2 + R1/R2/R6**（cannot/apology/promise/请告诉我 家族）——覆盖最典型假成功
4. **G6/G7/C4**——调用点一行传参（prompt/changedFiles/cost 都在作用域内）
5. C1 记为已知盲区；C2 繁简视成员构成决定是否处理

---

附注：① 验证靠静态正则推演（node 执行在本会话被权限拒绝），其中 R5-英文已覆盖、OV1–OV4 误报、C2 繁体三条建议用真实样本回归确认；② 留下一个未能删除的临时文件 `D:\app\AgentHub\.agenthub\verify-quality-gaps.mjs`（删除命令同样被拒），可手动删除。