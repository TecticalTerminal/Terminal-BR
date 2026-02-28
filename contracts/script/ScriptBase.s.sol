// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface Vm {
  function envUint(string calldata name) external returns (uint256 value);
  function envAddress(string calldata name) external returns (address value);
  function envBytes32(string calldata name) external returns (bytes32 value);
  function addr(uint256 privateKey) external returns (address keyAddr);
  function startBroadcast(uint256 privateKey) external;
  function stopBroadcast() external;
}

abstract contract ScriptBase {
  Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
}
