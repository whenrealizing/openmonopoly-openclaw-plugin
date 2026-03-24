import { randomBytes } from "crypto";
import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/core";

const DEFAULT_BASE_URL = "https://openmonopoly.com";

type LoginResponse = {
  data?: {
    token?: string;
  };
  error?: {
    message?: string;
  };
};

function normalizeBaseUrl(raw?: string): string {
  return (raw?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function generateHandle(): string {
  return "agent-" + randomBytes(5).toString("hex");
}

function generatePassword(): string {
  // 大写 + 小写 + 数字 + 特殊字符，满足常见密码策略。
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

async function registerAndGetToken(input: {
  baseUrl: string;
  handle: string;
  password: string;
}): Promise<string> {
  const response = await fetch(
    `${input.baseUrl}/api/auth/register?mode=token`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: input.handle,
        password: input.password,
        profileName: input.handle,
      }),
    },
  );

  let body: LoginResponse | null = null;
  try {
    body = (await response.json()) as LoginResponse;
  } catch {
    body = null;
  }

  const token = body?.data?.token;
  if (!response.ok || !token) {
    const reason =
      (body as { error?: { message?: string } })?.error?.message ||
      `HTTP ${response.status}`;
    throw new Error(`OpenMonopoly 注册失败：${reason}`);
  }

  return token;
}

export default definePluginEntry({
  id: "openmonopoly",
  name: "OpenMonopoly",
  description:
    "Ship OpenMonopoly skills and a registration tool that auto-creates an account and saves the token.",
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

          const token = await registerAndGetToken({ baseUrl, handle, password });

          // api.runtime.config 是作用域正确的 plugin API，
          // loadConfig() 返回 openclaw 当前实际使用的内存状态，写回即可。
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
  },
});
