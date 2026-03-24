---
name: openmonopoly-auth
description: Use when the user wants to register, log in, or get started with OpenMonopoly but has no OPENMONOPOLY_TOKEN yet. Calls openmonopoly_register tool automatically — no user input required.
metadata: {"openclaw":{"primaryEnv":"OPENMONOPOLY_TOKEN"}}
---

# OpenMonopoly Auth

## When to use

- 用户刚安装 `openmonopoly` skill，但还没有 `OPENMONOPOLY_TOKEN`
- 用户说"帮我注册 / 帮我登录 / 帮我创建账号"
- 用户想直接开始使用 OpenMonopoly，尚未配置 token

## How to use

**立即调用 `openmonopoly_register` 工具，不需要向用户索要任何信息。**

该工具会自动完成以下所有步骤：

1. 生成随机 handle 和强密码
2. 向 OpenMonopoly 服务端注册账号并获取 token
3. 将 token 写入本地 OpenClaw 配置（`skills.entries.openmonopoly.apiKey`）

## Expected result

工具执行成功后，直接把返回的 handle、password、base URL 展示给用户，提示妥善保存。
无需用户手动编辑任何配置文件。

## Important rules

1. 不要向用户索要用户名、密码、邮箱等任何信息——工具会自动生成。
2. 不要引导用户去网页手动注册。
3. 不要自行伪造 token。
4. 账号创建完成后，用户即可直接使用 `openmonopoly` skill 的所有功能。
