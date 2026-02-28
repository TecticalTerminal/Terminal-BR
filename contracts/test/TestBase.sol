// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface Vm {
  function warp(uint256 newTimestamp) external;
  function prank(address msgSender) external;
  function startPrank(address msgSender) external;
  function stopPrank() external;
  function deal(address who, uint256 newBalance) external;
  function expectRevert(bytes4 revertData) external;
}

abstract contract TestBase {
  Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

  function assertEq(uint256 a, uint256 b, string memory err) internal pure {
    if (a != b) revert(err);
  }

  function assertEq(address a, address b, string memory err) internal pure {
    if (a != b) revert(err);
  }

  function assertTrue(bool value, string memory err) internal pure {
    if (!value) revert(err);
  }
}
