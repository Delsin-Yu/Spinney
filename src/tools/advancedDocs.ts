/**
 * Folded ("advanced") tool docs — the gradual-reveal payload.
 *
 * The long-tail tools are no longer advertised in the model's tool list, but
 * they stay registered and executable. `CORE_PROMPT` keeps one line per topic
 * (topic — tools: summary); the model pulls the interface on demand with
 * `list_advanced_tool(topic)`.
 *
 * INVARIANT: this file ships with the extension and its text is shown to every
 * user, so it must stay free of workspace-specific facts (paths, script names,
 * repo layout). Workspace facts belong in the workspace's AGENTS.md snapshot
 * and the docs it points at. The bodies below are derived from the tool
 * `description`s and parameter schemas — do not re-invent semantics here; keep
 * them in sync when a tool signature changes.
 */
import { AgentTool, ToolDefinition } from '../agent/types';

export interface AdvancedTopicDoc {
  /** The folded tool names of this topic (empty when it is a pure convention). */
  tools: string[];
  /** One-line capability summary — the same line `CORE_PROMPT` shows. */
  summary: string;
  /** Interface body: tools, parameter table, one copyable example. */
  body: string;
}

export const ADVANCED_TOPIC_DOCS: Record<string, AdvancedTopicDoc> = {
  'background-terminal': {
    tools: ['check_background_terminal', 'kill_background', 'join_background'],
    summary: '管理 exec_command 后台模式起的长期任务',
    body: [
      '管理 exec_command 转成的后台终端：命令太慢（构建、测试、长任务）时先转后台继续干别的，之后再查 / 等 / 杀。',
      '',
      'id 是「会话内代号」（每个会话的 registry 从 1 递增），不是真实 OS pid，只在当前会话有效。',
      '',
      '涉及的工具与语法：',
      '- exec_command(command, cwd?, timeout?, timeout_behavior?) — 用 timeout_behavior 决定命令超时后的去向。',
      '- check_background_terminal(pid) — 查它是否还在跑、退出码、已累积的输出。',
      '- join_background(pid) — 阻塞等到命令结束，返回最终退出码与完整输出（响应 Stop）。',
      '- kill_background(pid) — 杀掉该后台终端的进程树。',
      '',
      '参数表（exec_command）：',
      '| 参数 | 类型 | 必填 | 说明 |',
      '| command | string | 是 | 要跑的 shell 命令。 |',
      '| cwd | string | 否 | 工作目录，相对工作区根目录。 |',
      '| timeout | number | 否 | 超时秒数，默认 120。 |',
      '| timeout_behavior | string："stop" / "move_to_background" / "start_in_background" | 否 | 超时后怎么办：stop 直接杀掉（默认）；move_to_background 把还在跑的命令转成后台终端并返回 id；start_in_background 立刻后台运行并返回 id（不等待）。 |',
      '',
      '参数表（check_background_terminal / kill_background / join_background）：',
      '| 参数 | 类型 | 必填 | 说明 |',
      '| pid | number | 是 | exec_command 返回的后台终端 id。 |',
      '',
      '关键行为：',
      '- 转后台的返回里会给出 id，以及 check / join / kill 的用法提示。',
      '- join 阻塞到命令结束；用户按 Stop 时立即返回「[command join was interrupted]」，该任务之后自然结束时仍会通知你。',
      '- 后台命令自然结束或被用户杀掉时，harness 会在当前回合结束后注入一张通知卡片（命令、退出码、输出尾部）。',
      '- 已经用 kill_background / join_background 处理过的任务不会再重复通知（工具结果里已经有结果了）。',
      '- 会话里有后台终端在跑时该会话被锁定（不能切换 / 删除 / 清空），也不能 hop_session。',
      '',
      '例子：',
      '{ "command": "npm run build", "timeout": 30, "timeout_behavior": "move_to_background" }',
      '返回 [command moved to background: id 3]；接着 { "pid": 3 } 调 join_background 等它跑完并取回完整输出，不想等了就 kill_background(3)。',
    ].join('\n'),
  },
  'sub-agents': {
    tools: ['spawn_agents', 'send_agent_message', 'spawn_readonly_agents', 'send_readonly_agent_message'],
    summary: '并行派子代理、恢复它们继续干',
    body: [
      '并行派子代理干活，或者恢复一个已经结束的子代理继续干。',
      '',
      '涉及的工具与语法：',
      '- spawn_agents — 主 agent 用；每个 spec 的 write 必填，true 才能写文件 / 跑命令，false 只读。',
      '- send_agent_message — 给一个已结束的子代理追加一条指令并重跑它（只能操作你自己派出去的）。',
      '- spawn_readonly_agents / send_readonly_agent_message — 只读子代理专用变体：参数里没有 write，子代理必定只读，防止越权。',
      '',
      '参数表（spawn_agents）：',
      '| 参数 | 类型 | 必填 | 说明 |',
      '| agents | array | 是 | 每个元素 { instruction: string（必填，任务描述）, write: boolean（必填，true = 可写文件 / 跑命令；false = 只读：read_file / list_dir / search_files）, model?: string（可选，只有用户明确要求换模型时才填） }。 |',
      '| mode | string："sync" / "async" | 否 | sync（默认）阻塞到全部结束并返回每份摘要；async 立刻返回 agent id，每个结束后以通知形式把结果送来。 |',
      '',
      '参数表（spawn_readonly_agents）：agents 元素只有 { instruction（必填）, model? }，没有 write；mode 同上。',
      '',
      '参数表（send_agent_message）：',
      '| 参数 | 类型 | 必填 | 说明 |',
      '| id | string | 是 | 之前 spawn_agents 返回的 agent 节点 id。 |',
      '| message | string | 是 | 追加的后续指令。 |',
      '| write | boolean | 否 | 覆盖本次的写权限，默认沿用该子代理原来的设置。 |',
      '| model | string | 否 | 覆盖模型，只在用户明确要求时填。 |',
      '| mode | string："sync" / "async" | 否 | sync（默认）阻塞并返回结果；async 立刻返回 id，结果稍后作为通知送来。 |',
      '',
      '参数表（send_readonly_agent_message）：id、message（必填），model?、mode?；没有 write 覆盖，恢复后仍只读。',
      '',
      '关键行为：',
      '- write 必填：漏掉会被拒绝（required 里包含 write）。',
      '- 深度硬上限 2：depth-1 子代理可以再派 depth-2；depth-2 不能再派（返回 "max sub-agent depth is 2"）。',
      '- 只读子代理只拿到 *_readonly_* 变体，写工具对它隐藏且调用会被拒；它派出去的子代理也强制只读。',
      '- 每个结束的子代理都带 stats（toolCalls / deniedToolCalls 计数与 token 用量）和 transcript（该子代理完整对话的 JSONL 绝对路径；摘要不够时用 read_file 读它）。',
      '',
      '例子：',
      '{ "agents": [ { "instruction": "审查 src/a.ts 的行尾处理，列出问题", "write": false }, { "instruction": "跑 npm run build 并报告错误", "write": true } ], "mode": "sync" }',
    ].join('\n'),
  },
  transcripts: {
    tools: ['search_transcripts'],
    summary: '检索历史会话和子代理的完整记录',
    body: [
      '检索历史会话和子代理运行的完整记录，用来回忆之前发生过什么。',
      '',
      '布局：<root>/<sessionId>/<nodeId>.jsonl —— 每个主 agent 回合一个文件（kind "session"），每次子代理运行一个文件（kind "subagent"）。这些目录默认在扩展的 global storage 里（工作区之外），search_files 到不了，只能用本工具（或用它返回的绝对路径配合 read_file）。',
      '',
      '工具与参数表（search_transcripts）：',
      '| 参数 | 类型 | 必填 | 说明 |',
      '| query | string | 否 | 要搜的正则（JS 语法）；省略则返回会话索引（id、文件数、大小、最后写入时间、标题）。 |',
      '| sessionId | string | 否 | 只搜 / 只列某一个会话。 |',
      '| kind | string："session" / "subagent" | 否 | 只搜主 agent 的回合，或只搜子代理的运行。 |',
      '| caseSensitive | boolean | 否 | 默认 false。 |',
      '| maxResults | number | 否 | 默认 50，上限 300。 |',
      '| context | number | 否 | 每个命中行前后各带几行上下文，0–10，默认 0。 |',
      '',
      '返回 "文件:行号: 文本"，路径是绝对路径。文件第 1 行是 meta（kind、会话标题、节点、状态、prompt、摘要、工具统计），之后每行一条 API 消息，渲染成 "[role] 文本 → tool(args)"。',
      '',
      '例子：',
      '{ "query": "spawn_agents", "kind": "subagent", "maxResults": 20 }',
      '命中后拿绝对路径翻页看完整未截断的记录：read_file("<root>/<sessionId>/<nodeId>.jsonl", 1, 40)。',
    ].join('\n'),
  },
  vision: {
    tools: ['read_image'],
    summary: '让视觉模型看磁盘上的图片',
    body: [
      '让视觉模型看磁盘上的图片（截图、设计稿、图表）。只有视觉模型支持：deepseek-v4-flash-vision-exp、deepseek-v4.1-flash-expires-on-0910；当前模型不是视觉模型时返回错误，需要先换模型。',
      '',
      '工具与参数表（read_image）：',
      '| 参数 | 类型 | 必填 | 说明 |',
      '| path | string | 是 | 图片路径，可绝对或相对工作区根目录。 |',
      '',
      '关键行为：',
      '- 图片上传到 DeepSeek Files API，请求里用返回的 file_id 引用（不内联 base64）；上传成功后作为一条 user 内容块跟在工具响应后面，下一轮你就能看到它。',
      '- 支持格式 JPEG / PNG / GIF / WebP，单张上限 64 MiB。',
      '- 非视觉模型下图片是「隐藏而非删除」：历史里的图片块在请求体里换成占位文本，切回视觉模型后原样恢复；被 provider 拒绝的图片则一直隐藏。',
      '',
      '例子：',
      '{ "path": "assets/icon.png" }',
      '返回 Loaded image <绝对路径> -> file-xxxxx (icon.png, 12.3 KiB).',
    ].join('\n'),
  },
  'file-verbatim-frame': {
    tools: [],
    summary: '写大段多行内容免转义（write_file / replace_in_file 的参数）',
    body: [
      '写大段 / 多行内容时用 verbatim frame，免得把换行、引号、反斜杠都转义一遍。这是 write_file / replace_in_file 的参数写法，没有单独的工具。',
      '',
      '语法：',
      '1. 参数是「JSON 头 + RAW 标记」：头里放小字段（path 等）并设 frame:true。',
      '2. 每段大内容包在 <<<RAW:字段名>>> 与 <<<END_RAW:字段名>>> 之间，中间原样写。',
      '3. 字段名必须与工具参数精确匹配：write_file 用 content，replace_in_file 用 oldText / newText。',
      '4. 开标记后紧跟的一个换行会被跳过，END_RAW 前那个换行会保留；标记要成对，不要嵌套同名标记。',
      '',
      '参数表：',
      '| 工具 | 字段 | 类型 | 必填 | 说明 |',
      '| write_file | path | string | 是 | 目标文件路径，可绝对或相对工作区根。 |',
      '| write_file | content | string | 是 | 文件全文；大段 / 多行时用 RAW 标记包住。 |',
      '| write_file | frame | boolean | 否 | 设 true 表示 content 走 verbatim frame。 |',
      '| replace_in_file | path | string | 是 | 要编辑的文件。 |',
      '| replace_in_file | oldText | string | 是 | 要精确匹配的原文，必须只出现一次。 |',
      '| replace_in_file | newText | string | 是 | 替换文本。 |',
      '| replace_in_file | frame | boolean | 否 | 设 true 表示 oldText / newText 走 verbatim frame。 |',
      '',
      '例子（write_file）：',
      '{ "path": "src/a.ts", "frame": true }',
      '<<<RAW:content>>>',
      'export function a() {',
      '  return "原样写入，不转义";',
      '}',
      '<<<END_RAW:content>>>',
      '',
      '例子（replace_in_file）：',
      '{ "path": "src/a.ts", "frame": true }',
      '<<<RAW:oldText>>>',
      '  return "旧";',
      '<<<END_RAW:oldText>>>',
      '<<<RAW:newText>>>',
      '  return "新";',
      '<<<END_RAW:newText>>>',
    ].join('\n'),
  },
  'session-hop': {
    tools: ['hop_session', 'list_nodes'],
    summary: '把任务交给新会话并在跑完后跳回；列出当前会话的对话树',
    body: [
      '把一个自包含任务交给一个全新会话去跑，跑完自动跳回本会话把它的最终回答带给你；顺带能列出当前会话的对话树。',
      '',
      '参数表（hop_session）：',
      '| 参数 | 类型 | 必填 | 说明 |',
      '| prompt | string | 是 | 交给新会话的完整任务；新会话看不到本会话，必须自包含。 |',
      '| title | string | 否 | 新会话的短标题。 |',
      '| returnNodeId | string | 否 | 结果回来后从这个节点开新分支（节点 id 用 list_nodes 拿）；省略则接在当前签出的节点后面。 |',
      '',
      '参数表（list_nodes）：无参数，返回当前会话的对话树（每行：节点 id、状态、父节点、标题，以及当前签出点）。',
      '',
      '关键行为：',
      '- hop 是排队执行的：调用立刻返回，本回合结束；新会话跑完 prompt 后 harness 跳回本会话，把新会话的最终回答当作用户消息交给你（你在新回合里继续）。',
      '- 一次只能跳一个；已有 hop 在排队时再调会返回「a session hop is already in progress」。',
      '- 本会话有后台终端在跑时拒绝跳转（先结束或 kill 掉它）。',
      '- 新会话看不到本会话的历史，所以 prompt 必须自包含；能在这里做完的事不要用它。',
      '',
      '例子：',
      '{ "prompt": "在空会话里跑 npm run build 并把错误按文件归类，最后给结论", "title": "build 排错" }',
      '想指定分支点：先 list_nodes() 拿到节点 id，再 hop_session({ "prompt": "…", "returnNodeId": "<节点 id>" })。',
    ].join('\n'),
  },
  'session-title': {
    tools: ['rename_session'],
    summary: '给会话改名（会话标题默认自动生成，显式改名会锁定它）',
    body: [
      '给会话（整个对话）改标题，而不是改某个节点。',
      '',
      '会话标题默认由 harness 自动生成：首轮结束后根据对话内容命名，之后对话继续增长时会自动更新（约每 2 分钟、且新增至少 2 个回合才刷新一次）。显式改名会「锁定」标题，自动命名不再覆盖它；想恢复自动命名由用户在侧栏右键「Auto-rename Session」重新开启。',
      '',
      '参数表（rename_session）：',
      '| 参数 | 类型 | 必填 | 说明 |',
      '| title | string | 是 | 新的会话标题：短（≤ 20 字）、单行、不带句末标点。 |',
      '| sessionId | string | 否 | 目标会话 id；省略 = 当前会话。 |',
      '',
      '关键行为：',
      '- 只有主 agent 能调用（子代理调用返回错误）。',
      '- 改名立即生效：侧栏列表与面板标题同步更新。',
      '- 锁定后自动命名不再动它；解锁会立刻重新生成一次标题。',
      '- 标题只用于显示，不影响历史、分支或上下文。',
      '',
      '例子：',
      '{ "title": "会话标题自动命名" }',
    ].join('\n'),
  },
};

/** Registry tools that are folded out of the model's tool list (still callable). */
export const ADVANCED_TOOL_NAMES: string[] = ['check_background_terminal', 'kill_background', 'join_background', 'search_transcripts'];

export const LIST_ADVANCED_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'list_advanced_tool',
    description:
      '列出/取回「折叠工具」的接口说明。折叠工具不出现在工具列表里，但可以直接调用；不确定参数时先用本工具取接口。无参 → 返回全部主题索引（每行 `topic — tools：一行说明`）；带 topic → 返回该主题的工具名、参数表和一个例子。未知 topic → 返回错误 + 可用 topic 列表。',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '要查看的主题名（见无参索引）；省略则返回全部主题索引。' },
      },
      required: [],
    },
  },
};

export function makeListAdvancedTool(): AgentTool {
  return {
    definition: LIST_ADVANCED_TOOL,
    async execute(args) {
      const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
      if (!topic) {
        return [
          '折叠工具主题索引（用 list_advanced_tool("<topic>") 取接口）：',
          ...Object.entries(ADVANCED_TOPIC_DOCS).map(
            ([k, d]) => `- ${k} — ${d.tools.join(' / ') || '(无工具)'}：${d.summary}`,
          ),
        ].join('\n');
      }
      const doc = ADVANCED_TOPIC_DOCS[topic];
      if (!doc) {
        return `Error: unknown topic "${topic}". Available topics: ${Object.keys(ADVANCED_TOPIC_DOCS).join(', ')}`;
      }
      return `# ${topic} — ${doc.summary}\n\n${doc.body}`;
    },
  };
}
