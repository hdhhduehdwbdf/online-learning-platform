function jsonNet(statusCode, body) {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) };
}

function toResponse(net) {
  return new Response(net.body, { status: net.statusCode, headers: net.headers || { "content-type": "application/json; charset=utf-8" } });
}

async function callDeepSeek(messages, temperature = 0.55, maxTokens = 0) {
  const apiKey = globalThis.envs?.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return jsonNet(503, { error: "服务端未配置 DEEPSEEK_API_KEY。", setup: "请在 Cloudflare Pages 的 Settings > Variables 配置。" });
  }
  const baseUrl = (globalThis.envs?.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
  const endpoint = baseUrl.endsWith("/chat/completions") ? baseUrl : baseUrl + "/chat/completions";
  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
      body: JSON.stringify({
        model: globalThis.envs?.DEEPSEEK_MODEL || "deepseek-chat",
        temperature,
        ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
        messages,
      }),
    });
    return { statusCode: upstream.status, headers: { "content-type": "application/json; charset=utf-8" }, body: await upstream.text() };
  } catch (error) {
    return jsonNet(502, { error: "AI request failed.", detail: String(error.message || error) });
  }
}

function extractAssistantContent(result) {
  if (!result || !result.body) return "";
  try {
    const data = JSON.parse(result.body);
    return data.choices?.[0]?.message?.content || "";
  } catch {
    return "";
  }
}

function parseJsonObject(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

const agentNames = { concept: "概念理解伙伴", planner: "任务规划伙伴", scenario: "情境应用伙伴", discussion: "共同讨论伙伴" };

const agentPrompts = {
  concept: "你是“概念理解伙伴”。你的任务是帮助学习者理解抽象概念、梳理知识结构和辨析重点难点。回答时优先使用“概念解释—具体例子—易错点—简短小结”的结构。你不能直接替学习者完成作业、生成完整答案或代替学习者进行最终判断。你应通过解释、举例、提问和小测帮助学习者自己理解。回答应简洁、有层次，必要时在最后提出一个简短检查问题。",
  planner: "你是“任务规划伙伴”。你的任务是帮助学习者理解任务要求、拆解任务步骤、制定阶段计划并进行温和提醒。你不能替学习者完成任务内容，不能直接生成完整作业、完整报告或最终提交文本。你可以提供任务框架、步骤建议、时间安排、模板说明和检查清单，但具体内容必须由学习者自己完成。每次建议优先给出当前最应该完成的 1-3 个行动。",
  scenario: "你是“情境应用伙伴”。你的任务是帮助学习者将知识放入真实问题和具体情境中理解与应用。你不能直接替学习者完成完整方案、完整案例分析或最终任务成果。你可以提供案例线索、分析框架和思考问题，但具体判断、方案设计和表达需要由学习者自己完成。回答优先围绕“问题是什么—为什么出现—可以怎么解决—知识如何发挥作用”展开。",
  discussion: "你是“共同讨论伙伴”。你的任务是帮助学习者进行讨论准备、观点整理、表达练习和互动反思。你不能直接替学习者发布讨论内容，不能代替学习者完成小组协作，也不能主导小组决策。你可以提供表达模板、观点整理建议、追问问题和共识总结。回答应温和、鼓励、低压力。",
};

const coordinatorPrompt = `你是“AI学伴协调器 Coordinator Agent”。你的任务不是直接回答学习问题，而是根据学习者画像、当前页面、当前章节、当前任务、学习行为数据和用户问题，判断本轮最适合由哪一类AI学伴提供支持。

可选AI学伴只有四类：
- concept：概念理解伙伴，适合概念、定义、知识结构、易错点。
- planner：任务规划伙伴，适合任务拆解、学习进度、截止日期、下一步行动。
- scenario：情境应用伙伴，适合真实案例、角色视角、知识迁移、方案合理性追问。
- discussion：共同讨论伙伴，适合讨论发言、观点整理、回应同伴、降低表达压力。

你必须输出严格JSON，不要输出Markdown，不要解释JSON之外的内容。格式如下：
{"selectedAgent":"concept|planner|scenario|discussion","secondaryAgent":"concept|planner|scenario|discussion|null","reason":"用一句中文说明为什么这样分配","strategy":"用一句中文说明主学伴应该怎样支持"}

约束：selectedAgent必须是四类之一；secondaryAgent可为null且不能与selectedAgent相同；如果用户要求直接生成完整作业，strategy必须要求以追问、框架或检查清单支持，不直接代写。`;

function normalizeCoordinatorDecision(input, fallbackAgent) {
  const validAgents = Object.keys(agentPrompts);
  const selectedAgent = validAgents.includes(input?.selectedAgent) ? input.selectedAgent : (fallbackAgent || "concept");
  const secondaryAgent = validAgents.includes(input?.secondaryAgent) && input.secondaryAgent !== selectedAgent ? input.secondaryAgent : null;
  return {
    selectedAgent,
    secondaryAgent,
    reason: String(input?.reason || "系统根据当前问题先交由" + agentNames[selectedAgent] + "支持。").slice(0, 140),
    strategy: String(input?.strategy || "先理解学习者已有想法，再通过提示、追问和框架帮助其完善。").slice(0, 180),
    source: input?.source || "coordinator",
  };
}

function heuristicCoordinatorDecision(payload) {
  const context = payload.learningContext || {};
  const lastMessage = [...(payload.messages || [])].reverse().find((item) => item.role === "user")?.content || "";
  const text = lastMessage + "\n" + (context.activeTool || "") + "\n" + (context.currentTask?.title || "");
  let selectedAgent = context.matchedAgent || "concept";
  let secondaryAgent = null;
  if (/概念|定义|含义|理论|区别|是什么|知识点|框架/.test(text)) selectedAgent = "concept";
  if (/任务|计划|进度|截止|ddl|步骤|先做|还有多少|安排|提交/.test(text)) selectedAgent = "planner";
  if (/案例|情境|场景|迁移|角色|方案|原因|策略|应用|双师|MOOC|SPOC|培训/.test(text)) selectedAgent = "scenario";
  if (/讨论|发言|回复|观点|同伴|小组|表达|帖子|怎么说/.test(text)) selectedAgent = "discussion";
  if (selectedAgent === "scenario" && /概念|定义|理论|知识点/.test(text)) secondaryAgent = "concept";
  if (selectedAgent === "planner" && /讨论|发言|小组/.test(text)) secondaryAgent = "discussion";
  return normalizeCoordinatorDecision({ selectedAgent, secondaryAgent, source: "heuristic" }, selectedAgent);
}

async function parseBody(request) {
  try {
    return JSON.parse(await request.text());
  } catch {
    return null;
  }
}

function guard(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") return toResponse(jsonNet(405, { error: "Method not allowed." }));
  return null;
}

async function handleDeepseek(request) {
  const payload = await parseBody(request);
  if (!payload) return toResponse(jsonNet(400, { error: "Invalid JSON body." }));
  return toResponse(await callDeepSeek(payload.messages || [], payload.temperature ?? 0.55, Number(payload.max_tokens) || 0));
}

async function handleAgentChat(request) {
  const payload = await parseBody(request);
  if (!payload) return toResponse(jsonNet(400, { error: "Invalid JSON body." }));
  const agentKey = payload.agentKey || "concept";
  const system = agentPrompts[agentKey] || agentPrompts.concept;
  return toResponse(await callDeepSeek([{ role: "system", content: system }, ...(payload.messages || [])]));
}

async function handleCoordinatorChat(request) {
  const payload = await parseBody(request);
  if (!payload) return toResponse(jsonNet(400, { error: "Invalid JSON body." }));
  const fallback = heuristicCoordinatorDecision(payload);
  const ctx = payload.learningContext || {};
  const coordinatorInput = {
    learnerProfile: ctx.profile || null,
    matchedAgent: ctx.matchedAgent || null,
    currentSection: ctx.currentSection || null,
    activeTool: ctx.activeTool || null,
    currentTask: ctx.currentTask || null,
    telemetry: ctx.telemetry || null,
    recentMessages: (payload.messages || []).slice(-8),
  };
  const coordinatorResult = await callDeepSeek(
    [
      { role: "system", content: coordinatorPrompt },
      { role: "user", content: JSON.stringify(coordinatorInput, null, 2) },
    ],
    0.1,
  );
  const coordinatorText = extractAssistantContent(coordinatorResult);
  if (coordinatorResult.statusCode >= 400 && !coordinatorText) return toResponse(coordinatorResult);
  const decision = normalizeCoordinatorDecision(parseJsonObject(coordinatorText) || fallback, fallback.selectedAgent);
  const secondaryNote = decision.secondaryAgent
    ? "本轮可参考辅助学伴“" + agentNames[decision.secondaryAgent] + "”的视角，但最终仍由你作为主学伴回答。"
    : "本轮不需要额外辅助学伴。";
  const system = agentPrompts[decision.selectedAgent] + "\n\n本轮由AI学伴协调器分配给你。\n协调器判断理由：" + decision.reason + "\n支持策略：" + decision.strategy + "\n" + secondaryNote + "\n\n回答要求：不要重复展示协调器JSON；用自然、温和、面向学习者的中文回答。优先基于学习者已经表达的内容进行追问、提示、框架化建议或检查清单，不要直接替学习者完成完整作业。";
  const answerResult = await callDeepSeek([{ role: "system", content: system }, ...(payload.messages || [])], 0.55);
  try {
    const data = JSON.parse(answerResult.body);
    data.coordinator = decision;
    return new Response(JSON.stringify(data), { status: answerResult.statusCode, headers: { "content-type": "application/json; charset=utf-8" } });
  } catch {
    return toResponse(answerResult);
  }
}

let resourceIndexCache = null;
async function readResourceIndex() {
  if (resourceIndexCache) return resourceIndexCache;
  try {
    const res = await globalThis.envs.ASSETS.fetch(new Request("https://assets.local/data/rag/resourceIndex.json"));
    resourceIndexCache = res.ok ? await res.json() : {};
  } catch {
    resourceIndexCache = {};
  }
  return resourceIndexCache;
}

async function handleSectionChat(request) {
  const payload = await parseBody(request);
  if (!payload) return toResponse(jsonNet(400, { error: "Invalid JSON body." }));
  const sectionTitle = payload.sectionTitle || payload.sectionId || "当前章节";
  let resourceFiles = payload.resourceFiles || "";
  let resourceText = typeof payload.sectionText === "string" && payload.sectionText.trim() ? payload.sectionText : "";
  if (!resourceText) {
    const index = await readResourceIndex();
    const entry = index[payload.sectionId] || index[String(payload.sectionId || "")];
    if (entry) {
      if (typeof entry.text === "string") resourceText = entry.text.slice(0, 28000);
      if (!resourceFiles && Array.isArray(entry.files) && entry.files.length) {
        resourceFiles = entry.files.map((f) => (f && typeof f === "object" ? f.label || f.file : String(f))).filter(Boolean).join("、");
      }
    }
  }
  if (!resourceFiles) resourceFiles = "暂无资源文件";
  const system = "你是课程章节知识问答 AI。你只能基于当前章节主题与提供的课程资源内容回答知识点问题，不要扮演匹配AI学伴，也不要提供任务规划、情绪支持或讨论陪练。\n\n如果资料中没有足够依据，请明确说“当前章节资源中没有直接依据”，再给出可以继续查阅的方向。回答要面向学生，清晰、简洁、分点，必要时引用“第几页”的线索。\n\n当前章节：" + sectionTitle + "\n当前资源文件：" + resourceFiles + "\n课程资源摘录：\n" + (resourceText || "该章节暂未上传资源。");
  return toResponse(
    await callDeepSeek(
      [
        { role: "system", content: system },
        { role: "user", content: payload.message || "" },
      ],
      0.25,
    ),
  );
}

export default {
  async fetch(request, env) {
    globalThis.envs = env;
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const handlers = {
        "/api/deepseek": handleDeepseek,
        "/api/agent-chat": handleAgentChat,
        "/api/coordinator-chat": handleCoordinatorChat,
        "/api/section-chat": handleSectionChat,
      };
      const fn = handlers[url.pathname];
      if (!fn) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "content-type": "application/json" } });
      const guarded = guard(request);
      if (guarded) return guarded;
      return fn(request);
    }
    return env.ASSETS.fetch(request);
  },
};
