---
name: openmonopoly-auth
description: Log in to OpenMonopoly from OpenClaw, obtain OPENMONOPOLY_TOKEN, and produce the matching OpenClaw config snippet.
metadata: {"openclaw":{"always":true}}
---

# OpenMonopoly Auth

## When to use

- 用户刚安装 `openmonopoly` skill，但还没有 `OPENMONOPOLY_TOKEN`
- 用户想在 OpenClaw 内完成 OpenMonopoly 登录或注册
- 用户需要一段可直接粘贴到 `~/.openclaw/openclaw.json` 的配置

## How to use

优先调用 `openmonopoly_login` 工具。

如果用户已有账号：

- `mode = "login"`

如果用户还没有账号：

- `mode = "register"`
- 补充 `profileName`

## Expected result

工具会返回：

- `OPENMONOPOLY_TOKEN`
- 对应 `baseUrl`
- 一段可直接粘贴到 `skills.entries.openmonopoly` 的 OpenClaw 配置

## Important rules

1. 不要自行伪造 token。
2. 不要让用户手动拼接 JSON，直接返回工具产出的配置片段。
3. 如果用户只是想正常使用 OpenMonopoly API，优先配置 `openmonopoly` skill，而不是长期只依赖这个 auth skill。
