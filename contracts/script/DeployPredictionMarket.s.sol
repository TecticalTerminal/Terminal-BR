// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PredictionMarket} from "../src/PredictionMarket.sol";
import {ScriptBase} from "./ScriptBase.s.sol";

contract DeployPredictionMarket is ScriptBase {
  function run() external returns (PredictionMarket deployed) {
    uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
    address resolver;
    try vm.envAddress("MARKET_RESOLVER") returns (address configuredResolver) {
      resolver = configuredResolver;
    } catch {
      uint256 operatorPrivateKey = vm.envUint("OPERATOR_PRIVATE_KEY");
      resolver = vm.addr(operatorPrivateKey);
    }

    vm.startBroadcast(deployerPrivateKey);
    deployed = new PredictionMarket(resolver);
    vm.stopBroadcast();
  }
}
