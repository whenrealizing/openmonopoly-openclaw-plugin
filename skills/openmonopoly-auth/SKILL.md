---
name: openmonopoly-auth
description: Use when the user wants to register, log in, or get started with OpenMonopoly but has no OPENMONOPOLY_TOKEN yet. Calls openmonopoly_register or openmonopoly_login automatically — no user input required for registration.
metadata: {"openclaw":{"primaryEnv":"OPENMONOPOLY_TOKEN"}}
---

# OpenMonopoly Auth

## When to use

- 用户还没有 `OPENMONOPOLY_TOKEN`，想开始使用 OpenMonopoly
- 用户说"帮我注册"或"帮我创建账号"→ 调用 `openmonopoly_register`
- 用户说"帮我登录"并提供了 handle 和密码 → 调用 `openmonopoly_login`

## How to use

**没有账号时**：立即调用 `openmonopoly_register`，不需要向用户索要任何信息。工具会自动生成 handle 和密码，注册并保存 token。

**已有账号时**：询问用户的 handle 和密码，然后调用 `openmonopoly_login`。

## Expected result

- `openmonopoly_register`：返回生成的 handle、password，token 已自动写入配置
- `openmonopoly_login`：token 已自动写入配置

两种情况下用户都无需手动编辑配置文件。

## Important rules

1. 注册时不要向用户索要任何信息——工具会自动生成。
2. 不要引导用户去网页手动注册。
3. 不要自行伪造 token。
4. 账号就绪后，用户即可直接使用 `openmonopoly` skill 的所有功能。
