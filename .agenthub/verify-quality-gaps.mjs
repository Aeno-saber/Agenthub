import { judgeOutput } from '../src/engine/quality.js'

const cases = [
  // ---- G1 道歉/能力不足 ----
  ['G1a-cn', '抱歉，我无法访问你的本地文件系统，因此不能完成修改。'],
  ['G1b-en', 'I cannot access your local file system, so I cannot complete the modification.'],
  ['G1c-en', "I'm unable to complete this task. Sorry!"],
  // ---- G2 承诺式占位 ----
  ['G2a-cn', '好的，我将开始分析代码并修复该 bug。'],
  ['G2b-en', 'I will now implement the fix.'],
  ['G2c-en', 'Sure, I can help with that!'],
  // ---- G3 usage 横幅 ----
  ['G3a', 'Usage: claude [options] [prompt]\n\nOptions:\n  -p, --print   print output and exit'],
  ['G3b', 'Missing required argument: prompt\nRun with --help for usage.'],
  // ---- G4 占位符 ----
  ['G4a', '已完成 {{module}} 的改造，TODO: <待补充>'],
  ['G4b', '已按 {目标} 完成修改，XXX 处细节待填。'],
  // ---- G5 堆栈 ----
  ['G5a-js', "TypeError: Cannot read properties of undefined (reading 'id')\n    at main (cli.js:12:19)"],
  ['G5b-py', 'Traceback (most recent call last):\n  File "x.py", line 1\nValueError: invalid literal'],
  // ---- G8 身份声明 ----
  ['G8a-cn', '我是一个由 Claude 驱动的 CLI 助手，我可以帮你完成编程任务。'],
  ['G8b-en', "As an AI language model, I don't have access to your local files."],
  // ---- G9 截断 ----
  ['G9a-dots', '分析结果如下：\n1. 首先我们检查了……\n2. 接着把……\n3. 最后……'],
  ['G9b-fence', '修改后的代码：\n```js\nfunction fix() {\n  // 未闭合'],
  // ---- R 变体 ----
  ['R4a-cn', '请问您指的是哪个模块？'],
  ['R4b-en', 'Could you clarify what you mean?'],
  ['R4c-en', 'Do you mean option A or option B?'],
  ['R5a-cn', '请手动执行以下命令来完成安装。'],
  ['R5b-cn', '建议联系管理员开通权限后再试。'],
  ['R5c-cn', '请提供你的 API key。'],
  ['R5d-en', 'Please provide your API key.'],
  ['R6a-cn', '当然可以！请告诉我您想实现什么功能。'],
  ['R7a-cn', '作为 AI 我无法在您的机器上运行代码。'],
  ['R1a-cn', '我不能修改文件，因为这超出了我的权限范围。'],
  ['R2a-cn', '对不起，我没有权限执行这个操作。'],
  ['R2b-en', "I'm sorry, but I can't help with that request."],
  // ---- E 环境错误 ----
  ['E2a-429', 'API Error: 429 rate_limit_error. Please retry after 30s.'],
  ['E2b-quota', 'You have exceeded your token quota. Please upgrade your plan.'],
  ['E2c-500', 'API Error: 500 internal_server_error'],
  ['E2d-overload', 'Overloaded. Please reduce prompt length or try again later.'],
  ['E2e-billing', 'Your credit balance is too low to access the API.'],
  ['E3a-dns', 'Error: getaddrinfo ENOTFOUND api.anthropic.com'],
  ['E3b-refused', 'Error: connect ECONNREFUSED 127.0.0.1:8080'],
  ['E3c-fetch', 'fetch failed: network error'],
  ['E3d-proxy', 'Error: tunneling socket could not be established'],
  ['E4a-cert', 'self-signed certificate in certificate chain'],
  ['E4b-cert2', 'unable to verify the first certificate'],
  ['E5a-timeout', 'Request timed out after 60000ms'],
  ['E6a-json-err', '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"已达到最大轮次"}'],
  ['E6b-raw-json', '{"type":"error","error":{"type":"api_error","message":"Internal server error"}}'],
  // ---- C2 繁体 ----
  ['C2a-tw', '您這條消息還沒有具體內容，請補充說明。'],
  // ---- C1 长推诿 ----
  ['C1a-long-refusal', ('以下是我能帮您做的事情的完整清单：\n- 分析代码\n- 编写文档\n- 修复 bug\n'.repeat(12)) + '总之，请告诉我您想让我做什么。'],
  ['C1b-long-env', ('排查过程：我们首先检查了网络配置，然后检查了凭据。\n'.repeat(15)) + '最终结论：Not logged in，请先运行 /login。'],
  // ---- 反向：误报风险（现有规则过宽）----
  ['FP1-broad-msg', '您的消息中提到的需求我已完成分析，结论如下：……'],
  ['FP2-401-substr', '编号 4012 的工单已处理完毕。'],
  ['FP3-no-content', 'The generated file has no content, so the test suite skipped it.'],
  ['FP4-没有内容', '检查发现该配置文件没有内容部分，属于正常现象。'],
]

for (const [id, text] of cases) {
  const r = judgeOutput(text, { status: 'ok' })
  console.log(
    id.padEnd(16),
    r.level.padEnd(8),
    JSON.stringify(r.codes).padEnd(20),
    'len=' + String(text.length).padStart(4),
    '| ' + text.slice(0, 36).replace(/\n/g, '\\n')
  )
}
