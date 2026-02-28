# Tactical Terminal Monorepo

[English](README.md)

## 项目概述
Tactical Terminal 是一个结合 AI Agent 对战、跨局资产、预测市场与 A2A 交易市场的 Web3 游戏型应用。

- 在线演示地址：`https://www.tecticalterminal.xyz`
- 演示视频：[在 YouTube 观看](https://youtu.be/a-NmW2W24uA)
- 演示账号：不提供演示账号，连接钱包即可体验

## 主要功能
- 8 Agent 开局配置（默认 7 Bot + 1 User）
- Agent 生命周期状态机（ACTIVE -> DEAD -> RESPAWNING -> ACTIVE）
- 跨局资产继承（Persistent Assets）
- A2A 固定价交易市场（上架 / 购买 / 撤单 / 成交记录）
- 双 Bot 一键自主交易（后端确定性流程 + 审计日志）
- 预测市场闭环（open -> bet -> resolve -> claim）
- 混合托管模型（User 外部钱包 + Bot 托管钱包）

## 技术栈
- 前端：React, TypeScript, Vite, wagmi/viem
- 后端：Node.js, Fastify, PostgreSQL
- 合约：Solidity, Foundry（Anvil / forge / cast）
- Monorepo：pnpm workspace, Turbo

## 项目结构
```text
apps/
  web/          # 前端应用（React + Vite）
  api/          # 后端服务（Fastify + PostgreSQL）
packages/
  shared-types/ # 前后端共享类型
  game-engine/  # 游戏引擎逻辑
  web3-sdk/     # Web3 工具封装
contracts/      # Foundry 合约工程（PredictionMarket / TacticalAgentNFT）
scripts/        # 联调、验收、部署辅助脚本
```

## 安装与运行
### 环境要求
- Node.js >= 20
- pnpm >= 10
- PostgreSQL（本地或云端）
- 可选：Foundry（本地链上联调时需要）

### 安装依赖
```bash
pnpm install
```

### 环境变量
按需从模板复制：
- `apps/api/.env.example` -> `apps/api/.env`
- `apps/web/.env.example` -> `apps/web/.env.local`
- `contracts/.env.example` -> `contracts/.env`（可选）

### 启动开发
仅前端：
```bash
pnpm dev
```

前后端联调：
```bash
# 终端1：启动 API
pnpm --filter @tactical/api run dev

# 终端2：启动 Web
pnpm --filter @tactical/web run dev
```

执行数据库迁移：
```bash
pnpm --filter @tactical/api run db:migrate
```

构建：
```bash
pnpm build
```

## 演示与部署
- 演示地址：`https://www.tecticalterminal.xyz`
- 账号策略：无需演示账号，仅连接钱包
- 推荐部署方式：
  - Web：Vercel
  - API：Render（或同类 Node 容器平台）
  - 合约：Sepolia（正式演示）/ Anvil（本地联调）

## 许可证
本项目采用 MIT License 开源，详见 [LICENSE](LICENSE)。

