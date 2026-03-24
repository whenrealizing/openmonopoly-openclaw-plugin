import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

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

  // 核心登录逻辑：直接命中 OpenMonopoly token 模式接口，避免在插件内复制业务认证流程。
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

  // 重要边界：服务端可能返回 200 但缺 token，也可能返回非 2xx 的错误体，这里统一收口成可读错误。
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
  description: "Ship OpenMonopoly skills and a login tool that returns a token plus ready-to-paste OpenClaw skill config.",
  register(api) {
    api.registerTool(
      {
        name: "openmonopoly_login",
        description:
          "Login or register with OpenMonopoly, then return OPENMONOPOLY_TOKEN and the matching OpenClaw skill config snippet.",
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

          const configSnippet = {
            skills: {
              entries: {
                openmonopoly: {
                  enabled: true,
                  apiKey: token,
                },
              },
            },
          };

          // 关键输出：返回 token 与配置片段，方便宿主或用户后续持久化；不在插件内擅自改本机配置。
          return {
            content: [
              {
                type: "text",
                text: [
                  `OpenMonopoly authentication succeeded for handle "${params.handle}".`,
                  `Base URL: ${baseUrl}`,
                  `OPENMONOPOLY_TOKEN: ${token}`,
                  "",
                  "Paste this into ~/.openclaw/openclaw.json:",
                  JSON.stringify(configSnippet, null, 2),
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
