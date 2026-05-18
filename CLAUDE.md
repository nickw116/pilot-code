# Pilot Agent

AI 编程助手后端服务，为 H5 前端提供多 agent 对话能力（Express + SSE）。

## 技术栈

- 后端：Node.js + TypeScript，用 `tsx` 直接运行（不编译）
- SDK：`@mariozechner/pi-agent-core`（Agent 类）+ `@mariozechner/pi-ai`（模型/流式）
- 前端：Vue 3 + Vant 4 + Vite
- 数据库：better-sqlite3（users.db + sessions.db）
- 通信：Express REST + SSE

## 常用命令

```bash
# 类型检查
npx tsc --noEmit

# 开发（自动重启）
npm run dev

# 生产
npm start

# 前端构建
cd frontend && npm run build

# 重启服务（生产）
sudo systemctl restart pilot-agent

# 健康检查
curl -s http://127.0.0.1:8081/api/health
# → {"status":"ok","version":"0.3.0"}
```

## 项目结构

```
src/
├── index.ts          # Express 入口，所有路由，端口 8081
├── agent.ts          # Agent 生命周期、模型注册、空闲回收
├── tools.ts          # Agent 工具集（read/write/edit/bash/claude_code/skill）
├── acp-client.ts     # ACP 协议客户端（opencode / claude_code 工具的底层）
├── session.ts        # 会话管理（SQLite），session key: agent:<id>:h5-<user>-<ts>
├── sse.ts            # SSE pub/sub 事件分发
├── event-bridge.ts   # Pi Agent 事件 → SSE 事件转换
├── compaction.ts     # 对话上下文压缩
├── auth.ts           # 用户认证（users.db SQLite）
├── audit.ts          # 审计日志
├── rate-limit.ts     # 请求限流
└── skills/           # Skill 定义（stock-chart-analysis、github 等）

frontend/src/
├── App.vue            # 根组件
├── composables/       # useAuth, useChat, useSend, useStreaming, useEventStream
├── components/        # SettingsPopup, SessionList, MessageInput, MessageBubble, AcpLogPanel
├── pages/             # LoginPage, ChatPage
├── router/            # 路由配置
└── constants/         # API 路径、token key
```

## 多 Agent 架构

`agents.json` 定义三个 agent，各有独立工具权限和工作区（`data/workspace/user-<id>/`）：

| Agent ID | 名称 | 工具 | 工作区 |
|----------|------|------|--------|
| `main` | 运维助手 | read, write, edit, bash, opencode, claude_code, skill | `user-<id>/` |
| `dev` | 开发助手 | read, bash, opencode, claude_code, skill | `user-<id>/dev/` |
| `user` | 个人助手 | read, bash, skill | `user-<id>/user/` |

工具过滤逻辑：`createUserTools(workspace, allowedTools)` 按 `agents.json` 的 `tools` 数组过滤。

## 编码约定

- 后端用 ESM（`"type": "module"`），import 带 `.js` 后缀（tsx 自动解析 `.ts`）
- 不用 `tsc` 编译，直接 `tsx` 运行，但保持类型正确（`npx tsc --noEmit` 通过）
- 前端是 Vue 3 Composition API + `<script setup>`，UI 库 Vant 4
- 数据库用 better-sqlite3，同步 API，SQL 文件无，schema 直接在代码中
- bash 安全过滤在 `tools.ts` 的 `DANGEROUS_COMMANDS` 数组中
- ACP 客户端（opencode/claude_code）在 `tools.ts` 中初始化，依赖环境变量 `OPENCODE_ENABLED` / `CLAUDE_CODE_ENABLED`

## 关键 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/login` | 登录 |
| POST | `/api/chat/v2` | 发消息（fire-and-forget，返回 runId） |
| GET | `/api/events?sessionKey=xxx` | SSE 事件流 |
| GET | `/api/agents` | agent 列表 |
| POST | `/api/sessions` | 创建会话（body: `{ agent_id }`） |
| GET/POST | `/api/models`, `/api/model/switch` | 模型列表/切换 |
| GET | `/api/history?sessionKey=xxx` | 历史消息 |
| POST | `/api/upload` | 文件上传 |
| POST | `/api/stt` | 语音转文字 |

## 改动验证

改完代码后必须验证无回归：

1. `npx tsc --noEmit` — 类型检查通过
2. `cd frontend && npm run build` — 前端构建通过
3. `sudo systemctl restart pilot-agent` — 重启服务
4. `curl -s http://127.0.0.1:8081/api/health` — 确认启动正常
5. **端到端 API 测试**（每次代码改动都必须执行）：
   - 登录：`curl -s http://127.0.0.1:8081/api/login -X POST -H "Content-Type: application/json" -d '{"username":"admin","password":"admin123"}'` → 获取 token
   - 用获取的 token 测试相关 API 端点（sessions、history、agents 等），确认返回格式正确、状态码正常
   - 如有权限相关改动，需分别用不同权限级别的用户测试（admin/main/dev/user）
6. `python3 /home/ubuntu/scripts/mimo-review.py` — MIMO 代码审查

## 注意

- `.env` 含 API Key（XIAOMI_API_KEY、DEEPSEEK_API_KEY），不在 git 中
- `data/` 存运行时数据（sessions、workspace），不在 git 中
- 生产前端由 Express 直接 serve `frontend/dist/`
- 不要修改 `data/workspace/` 下的用户文件
