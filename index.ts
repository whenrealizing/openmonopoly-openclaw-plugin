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

async function processWork(
  work: PendingWork,
  session: { sessionId: string; token: string; baseUrl: string },
  api: PluginApi,
  modelId: string,
): Promise<void> {
  const { sessionId, token, baseUrl } = session;
  try {
    const { runId } = await api.runtime.subagent.run({
      sessionKey: `openmonopoly-work-${work.workId}`,
      message: work.prompt,
      model: modelId,
    });
    const result = await api.runtime.subagent.waitForRun({
      runId,
      timeoutMs: 120_000,
    });
    await apiPost(
      `${baseUrl}/api/agent-pool/work-result`,
      {
        sessionId,
        workId: work.workId,
        status: result.status === "ok" ? "done" : "failed",
        result: { note: result.error ?? "completed" },
      },
      token,
    );
  } catch {
    await apiPost(
      `${baseUrl}/api/agent-pool/work-result`,
      { sessionId, workId: work.workId, status: "failed" },
      token,
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
          // 快速读取 body
          const raw = await new Promise<string>((resolve, reject) => {
            let data = "";
            req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
            req.on("end", () => resolve(data));
            req.on("error", reject);
          });

          // 校验 secret
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

    // ── 后台 Service（pull 模式 + 连接管理） ─────────────────────

    api.registerService({
      id: "openmonopoly-pool-worker",

      async start(ctx) {
        if (!poolCfg.enabled) return;

        const token = api.config.skills?.entries?.["openmonopoly"]?.apiKey as string | undefined;
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
            ctx.logger.info(`openmonopoly-pool-worker: 已连接 session=${sessionId} mode=${isPushMode ? "push" : "pull"}`);

            if (isPushMode) {
              // push 模式：只需保持 session 存活，工作由 webhook 路由处理
              // wait-for-work 充当心跳（每 30s 一次）
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
            ctx.logger.warn(`openmonopoly-pool-worker: 断线，${retryDelay}ms 后重连`, { err });
            await sleep(retryDelay);
            retryDelay = Math.min(retryDelay * 2, 60_000);
          }
        }
      },

      async stop(ctx) {
        const session = activeSession;
        activeSession = null;
        if (!session) return;
        // 干净断开，服务端立即标记 offline
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
