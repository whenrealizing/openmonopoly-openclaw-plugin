import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk";

type LoginMode = "login" | "register";

type LoginResponse = {
  data?: {
    token?: string;
  };
  error?: {
    message?: string;
  };
};

function normalizeBaseUrl(raw?: string): string {
  const value = raw?.trim();
  if (!value) {
    throw new Error("缺少 OpenMonopoly baseUrl，无法发起认证请求。");
  }

  return value.replace(/\/+$/, "");
}

async function requestOpenMonopolyToken(input: {
  baseUrl: string;
  mode: LoginMode;
  handle: string;
  password: string;
  profileName?: string;
}): Promise<string> {
  const endpoint =
    input.mode === "register"
      ? `${input.baseUrl}/api/auth/register?mode=token`
      : `${input.baseUrl}/api/auth/login?mode=token`;

  const payload =
    input.mode === "register"
      ? {
          handle: input.handle,
          password: input.password,
          profileName: input.profileName || input.handle,
        }
      : {
          handle: input.handle,
          password: input.password,
        };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  let body: LoginResponse | null = null;
  try {
    body = (await response.json()) as LoginResponse;
  } catch {
    body = null;
  }

  const token = body?.data?.token;
  if (!response.ok || !token) {
    const reason = body?.error?.message || `HTTP ${response.status}`;
    throw new Error(`OpenMonopoly 认证失败：${reason}`);
  }

  return token;
}

export default definePluginEntry({
  id: "openmonopoly",
  name: "OpenMonopoly",
  description: "Ship OpenMonopoly skills and a login tool that automatically saves the token to OpenClaw auth profiles.",
  register(api) {
    api.registerTool(
      {
        name: "openmonopoly_login",
        description:
          "Login or register with OpenMonopoly. Automatically saves the token to OpenClaw — no manual config needed.",
        parameters: Type.Object({
          baseUrl: Type.String({
            description:
              "OpenMonopoly API base URL, for example https://openmonopoly.example.com",
          }),
          mode: Type.Union([Type.Literal("login"), Type.Literal("register")], {
            description: "Use login for existing users and register for new users.",
          }),
          handle: Type.String({
            description: "OpenMonopoly handle.",
          }),
          password: Type.String({
            description: "OpenMonopoly password.",
          }),
          profileName: Type.Optional(
            Type.String({
              description: "Profile name used only when mode=register.",
            }),
          ),
        }),
        async execute(_id, params) {
          const baseUrl = normalizeBaseUrl(params.baseUrl);
          const token = await requestOpenMonopolyToken({
            baseUrl,
            mode: params.mode,
            handle: params.handle,
            password: params.password,
            profileName: params.profileName,
          });

          // 自动保存到 openclaw 加密凭证存储，用户无需手动粘贴配置。
          api.runtime.upsertAuthProfile({
            provider: "openmonopoly",
            authMethod: "token",
            token,
          });

          return {
            content: [
              {
                type: "text",
                text: [
                  `OpenMonopoly 认证成功（handle: "${params.handle}"）。`,
                  `Token 已自动保存，无需手动配置。`,
                  `Base URL: ${baseUrl}`,
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
