# Contracts Workspace (Foundry)

本目录实现了预测市场最小闭环合约流程：

- `openRound`
- `placeBet`
- `resolveRound`
- `claim`

## 目录结构

- `src/PredictionMarket.sol`：核心合约
- `test/PredictionMarket.t.sol`：最小闭环测试
- `script/DeployPredictionMarket.s.sol`：部署脚本
- `script/OpenRound.s.sol`：开盘脚本
- `script/ResolveRound.s.sol`：结算脚本
- `script/run_contract_loop.sh`：一键闭环脚本
- `run_contract_loop.sh`：兼容入口（转发到 `script/run_contract_loop.sh`）

## 前置依赖

- Foundry 工具链：`forge`、`cast`、`anvil`

安装（macOS + zsh）：

```bash
curl -L https://foundry.paradigm.xyz | bash
echo 'export PATH="$HOME/.foundry/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
foundryup
```

验证：

```bash
forge --version
cast --version
anvil --version
```

## 通用准备

1. 进入目录：

```bash
cd contracts
```

2. 合约编译与单测：

```bash
forge build
forge test -vv
```

3. 环境文件：

- `.env.anvil`：本地 Anvil 配置模板
- `.env.sepolia`：Sepolia 配置模板
- `.env`：当前激活配置（脚本实际读取）

切换示例：

```bash
cp .env.anvil .env
# 或
cp .env.sepolia .env
set -a; source .env; set +a
```

## Anvil 详细部署与验证流程

### 1) 启动本地链

终端 A：

```bash
anvil
```

### 2) 使用 Anvil 账户配置环境

终端 B：

```bash
cd contracts
cp .env.anvil .env
```

将 `.env` 中私钥替换为 `anvil` 启动日志打印的私钥：

- `DEPLOYER_PRIVATE_KEY`
- `OPERATOR_PRIVATE_KEY`

然后加载：

```bash
set -a; source .env; set +a
```

### 3) 一键执行闭环

```bash
./run_contract_loop.sh
```

### 4) 验证部署成功

```bash
cast code "$MARKET_ADDRESS" --rpc-url "$RPC_URL"
cast call "$MARKET_ADDRESS" "owner()(address)" --rpc-url "$RPC_URL"
cast call "$MARKET_ADDRESS" "resolver()(address)" --rpc-url "$RPC_URL"
cast call "$MARKET_ADDRESS" "nextRoundId()(uint256)" --rpc-url "$RPC_URL"
```

说明：

- `cast code` 返回非 `0x` 说明合约已部署。
- 若脚本执行了开盘，`nextRoundId` 应大于 `1`。
- Anvil 重启后链状态会重置，需要重新部署。

## Sepolia 详细部署与验证流程

### 1) 配置 Sepolia 环境

```bash
cd contracts
cp .env.sepolia .env
```

填写以下关键变量：

- `RPC_URL`：Sepolia RPC 地址
- `DEPLOYER_PRIVATE_KEY`：MetaMask Sepolia 部署账户私钥（`0x` 开头）
- `OPERATOR_PRIVATE_KEY`：MetaMask Sepolia 操作账户私钥（`0x` 开头）

加载变量：

```bash
set -a; source .env; set +a
```

链检查：

```bash
cast chain-id --rpc-url "$RPC_URL"
```

应返回 `11155111`。

### 2) 仅部署合约（推荐先做）

```bash
forge script script/DeployPredictionMarket.s.sol:DeployPredictionMarket \
  --rpc-url "$RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast -vvvv
```

从广播文件获取部署地址：

```bash
CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL")
grep -Eo '"contractAddress"[[:space:]]*:[[:space:]]*"0x[a-fA-F0-9]{40}"' \
  "broadcast/DeployPredictionMarket.s.sol/${CHAIN_ID}/run-latest.json" \
  | sed -E 's/.*"(0x[a-fA-F0-9]{40})".*/\1/' | head -n 1
```

### 3) 一键执行完整闭环（部署+开盘+下注+结算+领奖）

```bash
./run_contract_loop.sh
```

### 4) 部署后链上验证

```bash
cast code "$MARKET_ADDRESS" --rpc-url "$RPC_URL"
cast call "$MARKET_ADDRESS" "owner()(address)" --rpc-url "$RPC_URL"
cast call "$MARKET_ADDRESS" "resolver()(address)" --rpc-url "$RPC_URL"
cast call "$MARKET_ADDRESS" "nextRoundId()(uint256)" --rpc-url "$RPC_URL"
```

并在 Sepolia 浏览器查看 `MARKET_ADDRESS` 的创建交易与后续交互交易。

## 常见问题

- `forge: command not found`：Foundry 未安装或 PATH 未生效。
- `Dry run enabled`：确认使用最新脚本并使用 `--broadcast`。
- `Unauthorized`：`OPERATOR_PRIVATE_KEY` 与 resolver 地址不匹配。
- `insufficient funds`：账户测试币不足。
- `vm.envAddress...MARKET_RESOLVER`：可留空，部署脚本会自动用 `OPERATOR_PRIVATE_KEY` 推导 resolver。

## 与后端联动

- 后端需要维护 `gameId -> roundId` 映射。
- `GAME_OVER` 后由后端（resolver）调用 `resolveRound`。
- 前端下注/领奖通过 `placeBet`、`claim` 与合约交互。
