// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PredictionMarket} from "../src/PredictionMarket.sol";
import {TestBase} from "./TestBase.sol";

contract PredictionMarketTest is TestBase {
  PredictionMarket internal market;

  address internal constant OWNER = address(0xBEEF);
  address internal constant RESOLVER = address(0xC0FFEE);
  address internal constant ALICE = address(0xA11CE);
  address internal constant BOB = address(0xB0B);

  bytes32 internal constant GAME_ID = keccak256("game-1");
  bytes32 internal constant OUTCOME_A = keccak256("player-a");
  bytes32 internal constant OUTCOME_B = keccak256("player-b");

  function setUp() public {
    vm.startPrank(OWNER);
    market = new PredictionMarket(RESOLVER);
    vm.stopPrank();

    vm.deal(ALICE, 10 ether);
    vm.deal(BOB, 10 ether);
  }

  function testOpenBetResolveClaimFlow() public {
    uint64 lockAt = uint64(block.timestamp + 1 hours);

    vm.prank(RESOLVER);
    uint256 roundId = market.openRound(GAME_ID, lockAt);

    vm.prank(ALICE);
    market.placeBet{value: 1 ether}(roundId, OUTCOME_A);

    vm.prank(BOB);
    market.placeBet{value: 3 ether}(roundId, OUTCOME_B); // Total Pool = 4 ether

    vm.warp(block.timestamp + 1 hours + 1);

    vm.prank(RESOLVER);
    market.resolveRound(roundId, OUTCOME_A); // Alice wins

    // Expected distributable = 4 ether * 94% = 3.76 ether
    // Alice gets 100% of winner pool = 3.76 ether
    uint256 expectedPayout = 3.76 ether;

    uint256 preview = market.previewClaim(roundId, ALICE);
    assertEq(preview, expectedPayout, "alice payout mismatch");

    uint256 aliceBefore = ALICE.balance;
    vm.prank(ALICE);
    uint256 payout = market.claim(roundId);
    uint256 aliceAfter = ALICE.balance;

    assertEq(payout, expectedPayout, "claim return mismatch");
    assertEq(aliceAfter - aliceBefore, expectedPayout, "alice balance mismatch");

    vm.prank(ALICE);
    vm.expectRevert(PredictionMarket.AlreadyClaimed.selector);
    market.claim(roundId);

    vm.prank(BOB);
    vm.expectRevert(PredictionMarket.NothingToClaim.selector);
    market.claim(roundId);
  }

  function testResolveWithoutWinnersMovesPoolToTreasury() public {
    uint64 lockAt = uint64(block.timestamp + 1 days);

    vm.prank(RESOLVER);
    uint256 roundId = market.openRound(keccak256("game-2"), lockAt);

    vm.prank(ALICE);
    market.placeBet{value: 2 ether}(roundId, OUTCOME_A);

    vm.warp(block.timestamp + 1 days + 1);

    vm.prank(RESOLVER);
    market.resolveRound(roundId, OUTCOME_B);

    assertEq(market.pendingTreasury(), 2 ether, "treasury should include full pool");
    assertEq(market.pendingCreatorTreasury(), 0, "creator treasury should be 0 when no payout");
    assertEq(market.previewClaim(roundId, ALICE), 0, "alice should not be claimable");
  }

  function testCannotBetAfterLock() public {
    uint64 lockAt = uint64(block.timestamp + 100);

    vm.prank(RESOLVER);
    uint256 roundId = market.openRound(keccak256("game-3"), lockAt);

    vm.warp(lockAt);

    vm.prank(ALICE);
    vm.expectRevert(PredictionMarket.RoundClosed.selector);
    market.placeBet{value: 1 ether}(roundId, OUTCOME_A);
  }

  function testOwnerCanWithdrawTreasury() public {
    uint64 lockAt = uint64(block.timestamp + 200);

    vm.prank(RESOLVER);
    uint256 roundId = market.openRound(keccak256("game-4"), lockAt);

    vm.prank(ALICE);
    market.placeBet{value: 1 ether}(roundId, OUTCOME_A);

    vm.warp(lockAt + 1);

    vm.prank(RESOLVER);
    market.resolveRound(roundId, OUTCOME_A);

    // Total Pool = 1 ether.
    // 5% Treasury = 0.05 ether
    // 1% Creator =  0.01 ether
    uint256 expectedTreasury = 0.05 ether;
    uint256 expectedCreatorTreasury = 0.01 ether;

    assertEq(market.pendingTreasury(), expectedTreasury, "fee treasury mismatch");
    assertEq(market.pendingCreatorTreasury(), expectedCreatorTreasury, "creator treasury mismatch");

    // Withdraw Main Treasury
    uint256 mainTreasury = market.pendingTreasury();
    uint256 ownerBefore = OWNER.balance;
    vm.prank(OWNER);
    market.withdrawTreasury(payable(OWNER), mainTreasury);
    uint256 ownerAfter = OWNER.balance;

    assertEq(ownerAfter - ownerBefore, expectedTreasury, "owner treasury withdrawal mismatch");
    
    // Withdraw Creator Treasury
    uint256 creatorTreasury = market.pendingCreatorTreasury();
    ownerBefore = OWNER.balance;
    vm.prank(OWNER);
    market.withdrawCreatorTreasury(payable(OWNER), creatorTreasury);
    ownerAfter = OWNER.balance;

    assertEq(ownerAfter - ownerBefore, expectedCreatorTreasury, "owner creator withdrawal mismatch");
  }
}
