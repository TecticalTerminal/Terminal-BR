// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PredictionMarket} from "../src/PredictionMarket.sol";
import {ScriptBase} from "./ScriptBase.s.sol";

contract OpenRound is ScriptBase {
  function run() external {
    uint256 operatorPrivateKey = vm.envUint("OPERATOR_PRIVATE_KEY");
    address marketAddress = vm.envAddress("MARKET_ADDRESS");
    bytes32 gameIdHash = vm.envBytes32("GAME_ID_HASH");
    uint64 lockAt = uint64(vm.envUint("ROUND_LOCK_AT"));

    vm.startBroadcast(operatorPrivateKey);
    PredictionMarket(marketAddress).openRound(gameIdHash, lockAt);
    vm.stopBroadcast();
  }
}
