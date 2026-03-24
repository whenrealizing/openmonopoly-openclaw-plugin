import { randomBytes } from "crypto";
import { IncomingMessage, ServerResponse } from "http";
import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/core";

const DEFAULT_BASE_URL = "https://openmonopoly.com";

type PluginCfg = {
  agentPool?: {
    enabled?: boolean;
    modelId?: string;
    platform?: "cli" | "telegram" | "feishu" | "custom";
    webhookUrl?: string;
    webhookSecret?: string;
  };
};

type ApiResponse = {
  data?: Record<string, unknown>;
  error?: { message?: string };
};

type PendingWork = {
  workId: string;
  workType: string;
  prompt: string;
  context: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
};

// 模块级 session 状态，供 webhook handler 共享
let activeSession: { sessionId: string; token: string; baseUrl: string } | null = null;

function normalizeBaseUrl(raw?: string): string {
  return (raw?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function generateHandle(): string {
  return "agent-" + randomBytes(5).toString("hex");
}

function generatePassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const special = "!@#$%^&*";
  const all = upper + lower + digits + special;
  const bytes = randomBytes(16);
  let pwd =
    upper[bytes[0] % upper.length] +
    lower[bytes[1] % lower.length] +
    digits[bytes[2] % digits.length] +
    special[bytes[3] % special.length];
  for (let i = 4; i < 16; i++) {
    pwd += all[bytes[i] % all.length];
  }
  return pwd;
}

async function apiPost(
  url: string,
  body: unknown,
  token?: string,
): Promise<ApiResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let parsed: ApiResponse | null = null;
  try {
    parsed = (await response.json()) as ApiResponse;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const reason = parsed?.error?.message || `HTTP ${response.status}`;
    throw new Error(reason);
  }
  return parsed ?? {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PluginApi = Parameters<Parameters<typeof definePluginEntry>[0]["register"]>[0];

async function saveToken(api: PluginApi, token: string): Promise<void> {
  const cfg = api.runtime.config.loadConfig();
  await api.runtime.config.writeConfigFile({
    ...cfg,
    skills: {
      ...cfg.skills,
      entries: {
        ...cfg.skills?.entries,
        openmonopoly: {
          ...cfg.skills?.entries?.["openmonopoly"],
          enabled: true,
          apiKey: token,
        },
      },
    },
  });
}

/**
 * 根据 workType 生成 subagent 完整指令。
 *
 * subagent 负责：处理任务 + 调用 POST /api/agent-pool/work-result 提交结果。
 * 插件只在 subagent 运行失败时兜底提交 { status: "failed" }。
 */
function buildWorkMessage(
  work: PendingWork,
  session: { sessionId: string; token: string; baseUrl: string },
): string {
  const { sessionId, token, baseUrl } = session;

  // workType 专属结果格式说明
  const resultSchemaByType: Record<string, { example: unknown; description: string }> = {
    task_post: {
      example: {
        note: "交付内容说明",
        artifacts: [{ uri: "https://assets.openmonopoly.com/file.pdf", hash: "sha256:..." }],
      },
      description:
        'note（string）：交付说明。artifacts（可选）：交付文件列表，每项含 uri 和 hash（sha256:前缀）。artifacts 为空数组时可省略。',
    },
    arbitration: {
      example: { verdict: "buyer_win", rationale: "详细裁决理由" },
      description:
        'verdict 必填，枚举值：buyer_win | seller_win | split。rationale 必填，详细说明裁决依据。',
    },
    arbitration_vote: {
      example: { verdict: "buyer_win", reason: "投票理由（可选）" },
      description:
        'verdict 必填，枚举值：buyer_win | seller_win | split。reason 可选。',
    },
  };

  const schema = resultSchemaByType[work.workType] ?? {
    example: { note: "completed" },
    description: "未知 workType，提交任意 JSON 作为结果。",
  };

  const successBody = JSON.stringify(
    { sessionId, workId: work.workId, status: "done", result: schema.example },
    null,
    2,
  );
  const failBody = JSON.stringify(
    { sessionId, workId: work.workId, status: "failed" },
    null,
    2,
  );

  const parts: string[] = [
    work.prompt,
    "",
    "---",
    `【任务元数据】`,
    `workType: ${work.workType}`,
    `workId: ${work.workId}`,
  ];

  if (work.capabilities) {
    parts.push(
      "",
      "【可用 API 能力】",
      JSON.stringify(work.capabilities, null, 2),
    );
  }

  if (Object.keys(work.context).length > 0) {
    parts.push(
      "",
      "【业务上下文】",
      JSON.stringify(work.context, null, 2),
    );
  }

  parts.push(
    "",
    "【完成后提交结果】",
    `POST ${baseUrl}/api/agent-pool/work-result`,
    `Authorization: Bearer ${token}`,
    `Content-Type: application/json`,
    "",
    "成功时的请求体（result 字段说明：" + schema.description + "）：",
    successBody,
    "",
    "无法完成时提交：",
    failBody,
    "",
    "【重要】必须在完成任务后主动调用上述接口提交结果，否则任务不会被标记为完成。",
  );

  return parts.join("\n");
}

async function processWork(
  work: PendingWork,
  session: { sessionId: string; token: string; baseUrl: string },
  api: PluginApi,
  modelId: string,
): Promise<void> {
  try {
    const { runId } = await api.runtime.subagent.run({
      sessionKey: `openmonopoly-work-${work.workId}`,
      message: buildWorkMessage(work, session),
      model: modelId,
    });
    const result = await api.runtime.subagent.waitForRun({
      runId,
      timeoutMs: 120_000,
    });

    if (result.status !== "ok") {
      // subagent 本身失败（超时、错误），兜底提交 failed
      await apiPost(
        `${session.baseUrl}/api/agent-pool/work-result`,
        { sessionId: session.sessionId, workId: work.workId, status: "failed" },
        session.token,
      );
    }
    // status === "ok" 时，subagent 已在任务内调用 work-result 接口，无需再提交
  } catch {
    await apiPost(
      `${session.baseUrl}/api/agent-pool/work-result`,
      { sessionId: session.sessionId, workId: work.workId, status: "failed" },
      session.token,
    ).catch(() => {});
  }
}

async function connectToPool(
  token: string,
  baseUrl: string,
  platform: string,
  webhookUrl?: string,
): Promise<string> {
  const body: Record<string, unknown> = { platform };
  if (webhookUrl) body["webhookUrl"] = webhookUrl;
  const res = await apiPost(`${baseUrl}/api/agent-pool/connect`, body, token);
  const sessionId = res.data?.["sessionId"] as string | undefined;
  if (!sessionId) throw new Error("connect 响应中无 sessionId");
  return sessionId;
}

export default definePluginEntry({
  id: "openmonopoly",
  name: "OpenMonopoly",
  description:
    "Ship OpenMonopoly skills plus tools to register or log in, and a background agent pool worker.",
  register(api) {
    // ── 注册工具 ────────────────────────────────────────────────────

    api.registerTool(
      {
        name: "openmonopoly_register",
        description:
          "Auto-create an OpenMonopoly account with a generated handle and password, then save the token automatically. No user input needed.",
        parameters: Type.Object({
          baseUrl: Type.Optional(
            Type.String({ description: `OpenMonopoly API base URL. Defaults to ${DEFAULT_BASE_URL}.` }),
          ),
        }),
        async execute(_id, params) {
          const baseUrl = normalizeBaseUrl(params.baseUrl);
          const handle = generateHandle();
          const password = generatePassword();
          const body = await apiPost(
            `${baseUrl}/api/auth/register?mode=token`,
            { handle, password, profileName: handle },
          );
          const token = body.data?.["token"] as string | undefined;
          if (!token) throw new Error("OpenMonopoly 注册失败：响应中无 token");
          await saveToken(api, token);
          return {
            content: [{
              type: "text",
              text: [
                "OpenMonopoly 账号注册成功，token 已自动保存。",
                "",
                "请妥善保存以下凭证（用于登录 OpenMonopoly 网站或找回账号）：",
                `Handle：${handle}`,
                `Password：${password}`,
                `Base URL：${baseUrl}`,
              ].join("\n"),
            }],
          };
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "openmonopoly_login",
        description:
          "Log in to an existing OpenMonopoly account with handle and password, then save the token automatically.",
        parameters: Type.Object({
          handle: Type.String({ description: "OpenMonopoly handle." }),
          password: Type.String({ description: "Account password." }),
          baseUrl: Type.Optional(
            Type.String({ description: `OpenMonopoly API base URL. Defaults to ${DEFAULT_BASE_URL}.` }),
          ),
        }),
        async execute(_id, params) {
          const baseUrl = normalizeBaseUrl(params.baseUrl);
          const body = await apiPost(
            `${baseUrl}/api/auth/login?mode=token`,
            { handle: params.handle, password: params.password },
          );
          // login 返回 data.sessionToken，与 register 的 data.token 不同
          const token = body.data?.["sessionToken"] as string | undefined;
          if (!token) throw new Error("OpenMonopoly 登录失败：响应中无 sessionToken");
          await saveToken(api, token);
          return {
            content: [{
              type: "text",
              text: `OpenMonopoly 登录成功，token 已自动保存。Handle：${params.handle}`,
            }],
          };
        },
      },
      { optional: true },
    );

    // ── Webhook 路由（push 模式） ─────────────────────────────────

    const pluginCfg = (api.pluginConfig ?? {}) as PluginCfg;
    const poolCfg = pluginCfg.agentPool ?? {};
    const modelId = poolCfg.modelId ?? "claude-sonnet-4-6";

    if (poolCfg.webhookUrl) {
      api.registerHttpRoute({
        path: "/openmonopoly/work",
        auth: "plugin",
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const raw = await new Promise<string>((resolve, reject) => {
            let data = "";
            req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
            req.on("end", () => resolve(data));
            req.on("error", reject);
          });

          const incomingSecret = (req.headers["x-openmonopoly-secret"] as string) ?? "";
          if (poolCfg.webhookSecret && incomingSecret !== poolCfg.webhookSecret) {
            res.writeHead(401).end("Unauthorized");
            return;
          }

          let work: PendingWork;
          try {
            work = JSON.parse(raw) as PendingWork;
          } catch {
            res.writeHead(400).end("Bad Request");
            return;
          }

          // 立即返回 200，异步处理
          res.writeHead(200).end("ok");

          const session = activeSession;
          if (!session) return;
          processWork(work, session, api, modelId).catch(() => {});
        },
      });
    }

    // ── 后台 Service ─────────────────────────────────────────────

    api.registerService({
      id: "openmonopoly-pool-worker",

      async start(ctx) {
        if (!poolCfg.enabled) return;

        // 用 loadConfig() 读运行时最新配置，避免 api.config 快照过期
        const token = api.runtime.config.loadConfig()
          .skills?.entries?.["openmonopoly"]?.apiKey as string | undefined;

        if (!token) {
          ctx.logger.warn("openmonopoly-pool-worker: 未找到 OPENMONOPOLY_TOKEN，跳过启动");
          return;
        }

        const baseUrl = DEFAULT_BASE_URL;
        const platform = poolCfg.platform ?? "cli";
        const webhookUrl = poolCfg.webhookUrl;
        const isPushMode = !!webhookUrl;

        // 标记自己在线
        await fetch(`${baseUrl}/api/profiles/me/profile`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ agentPool: { inPool: true, modelId } }),
        }).catch(() => {});

        let retryDelay = 2_000;

        while (true) {
          try {
            const sessionId = await connectToPool(token, baseUrl, platform, webhookUrl);
            activeSession = { sessionId, token, baseUrl };
            retryDelay = 2_000;
            ctx.logger.info(
              `openmonopoly-pool-worker: 已连接 session=${sessionId} mode=${isPushMode ? "push" : "pull"}`,
            );

            if (isPushMode) {
              // push 模式：循环调 wait-for-work 充当心跳，实际工作由 webhook 路由处理
              while (true) {
                await apiPost(
                  `${baseUrl}/api/composite/agent-pool/wait-for-work`,
                  { sessionId, timeoutSec: 30 },
                  token,
                );
              }
            } else {
              // pull 模式：主动拉取任务
              while (true) {
                const res = await apiPost(
                  `${baseUrl}/api/composite/agent-pool/wait-for-work`,
                  { sessionId, timeoutSec: 30 },
                  token,
                );
                const work = res.data?.["pendingWork"] as PendingWork | null;
                if (!work) continue;
                // fire-and-forget，不阻塞拉取循环
                processWork(work, { sessionId, token, baseUrl }, api, modelId).catch(() => {});
              }
            }
          } catch (err) {
            activeSession = null;
            ctx.logger.warn(
              `openmonopoly-pool-worker: 断线，${retryDelay}ms 后重连`,
              { err },
            );
            await sleep(retryDelay);
            retryDelay = Math.min(retryDelay * 2, 60_000);
          }
        }
      },

      async stop(ctx) {
        const session = activeSession;
        activeSession = null;
        if (!session) return;
        await apiPost(
          `${session.baseUrl}/api/agent-pool/disconnect`,
          { sessionId: session.sessionId },
          session.token,
        ).catch((err) => {
          ctx.logger.warn("openmonopoly-pool-worker: disconnect 失败", { err });
        });
      },
    });
  },
});
