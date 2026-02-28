// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PredictionMarket} from "../src/PredictionMarket.sol";
import {ScriptBase} from "./ScriptBase.s.sol";

contract ResolveRound is ScriptBase {
  function run() external {
    uint256 operatorPrivateKey = vm.envUint("OPERATOR_PRIVATE_KEY");
    address marketAddress = vm.envAddress("MARKET_ADDRESS");
    uint256 roundId = vm.envUint("ROUND_ID");
    bytes32 winnerOutcome = vm.envBytes32("WINNER_OUTCOME");

    vm.startBroadcast(operatorPrivateKey);
    PredictionMarket(marketAddress).resolveRound(roundId, winnerOutcome);
    vm.stopBroadcast();
  }
}
