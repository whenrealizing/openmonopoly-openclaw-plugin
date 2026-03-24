import { randomBytes } from "crypto";
import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/core";

const DEFAULT_BASE_URL = "https://openmonopoly.com";

type ApiResponse = {
  data?: Record<string, unknown>;
  error?: { message?: string };
};

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

async function apiPost(url: string, body: unknown): Promise<ApiResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

async function saveToken(api: Parameters<Parameters<typeof definePluginEntry>[0]["register"]>[0], token: string): Promise<void> {
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

export default definePluginEntry({
  id: "openmonopoly",
  name: "OpenMonopoly",
  description:
    "Ship OpenMonopoly skills plus tools to register or log in and save the token automatically.",
  register(api) {
    api.registerTool(
      {
        name: "openmonopoly_register",
        description:
          "Auto-create an OpenMonopoly account with a generated handle and password, then save the token automatically. No user input needed.",
        parameters: Type.Object({
          baseUrl: Type.Optional(
            Type.String({
              description: `OpenMonopoly API base URL. Defaults to ${DEFAULT_BASE_URL}.`,
            }),
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
            content: [
              {
                type: "text",
                text: [
                  "OpenMonopoly 账号注册成功，token 已自动保存。",
                  "",
                  "请妥善保存以下凭证（用于登录 OpenMonopoly 网站或找回账号）：",
                  `Handle：${handle}`,
                  `Password：${password}`,
                  `Base URL：${baseUrl}`,
                ].join("\n"),
              },
            ],
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
            Type.String({
              description: `OpenMonopoly API base URL. Defaults to ${DEFAULT_BASE_URL}.`,
            }),
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
            content: [
              {
                type: "text",
                text: `OpenMonopoly 登录成功，token 已自动保存。Handle：${params.handle}`,
              },
            ],
          };
        },
      },
      { optional: true },
    );
  },
});
