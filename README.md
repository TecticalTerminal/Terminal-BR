# Tactical Terminal Monorepo

[中文文档](README.zh.md)

## Overview
Tactical Terminal is a Web3 game-style application combining AI agent gameplay, persistent assets, prediction market, and A2A marketplace.

- Live demo: `https://www.tecticalterminal.xyz`
- Demo video: [Watch on YouTube](https://youtu.be/a-NmW2W24uA)
- Demo account: no demo account is provided. Just connect your wallet.

## Core Features
- 8-agent match setup (default: 7 bots + 1 user)
- Agent lifecycle state machine (ACTIVE -> DEAD -> RESPAWNING -> ACTIVE)
- Cross-round persistent asset inheritance
- A2A fixed-price marketplace (list / buy / cancel / trade history)
- One-click autonomous bot-to-bot trade (deterministic backend flow + audit logs)
- Prediction market loop (open -> bet -> resolve -> claim)
- Mixed custody model (user external wallet + bot managed wallets)

## Tech Stack
<img width="2752" height="1536" alt="image" src="https://github.com/user-attachments/assets/6a66b4c4-d1e1-4baf-954b-eea80f77922b" />

- Frontend: React, TypeScript, Vite, wagmi/viem
- Backend: Node.js, Fastify, PostgreSQL
- Smart contracts: Solidity, Foundry (Anvil / forge / cast)
- Monorepo tooling: pnpm workspace, Turbo

## Repository Structure
```text
apps/
  web/          # Frontend app (React + Vite)
  api/          # Backend service (Fastify + PostgreSQL)
packages/
  shared-types/ # Shared types across web/api
  game-engine/  # Core game logic
  web3-sdk/     # Web3 utilities
contracts/      # Foundry workspace (PredictionMarket / TacticalAgentNFT)
scripts/        # Integration, acceptance, and deployment scripts
```

## Installation & Run
### Prerequisites
- Node.js >= 20
- pnpm >= 10
- PostgreSQL (local or managed)
- Optional: Foundry for local chain integration

### Install
```bash
pnpm install
```

### Environment Variables
Copy templates as needed:
- `apps/api/.env.example` -> `apps/api/.env`
- `apps/web/.env.example` -> `apps/web/.env.local`
- `contracts/.env.example` -> `contracts/.env` (optional)

### Start Development
Web only:
```bash
pnpm dev
```

Full stack:
```bash
# Terminal 1: API
pnpm --filter @tactical/api run dev

# Terminal 2: Web
pnpm --filter @tactical/web run dev
```

Run DB migrations:
```bash
pnpm --filter @tactical/api run db:migrate
```

Build:
```bash
pnpm build
```

## Demo & Deployment
- Demo URL: `https://www.tecticalterminal.xyz`
- Account policy: wallet connection only (no demo account)
- Recommended deployment:
  - Web: Vercel
  - API: Render (or equivalent Node container platform)
  - Contracts: Sepolia for demo / Anvil for local integration

## License
This project is licensed under the MIT License. See [LICENSE](LICENSE).

