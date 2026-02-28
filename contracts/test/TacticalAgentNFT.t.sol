// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/TacticalAgentNFT.sol";

contract TacticalAgentNFTTest is Test {
    TacticalAgentNFT public agentNFT;
    address public owner = address(1);
    address public gameServer = address(2);
    address public userA = address(3);
    address public userB = address(4);

    uint256 public constant MINT_FEE = 0.01 ether;
    string public constant SOUL_HASH = "QmTestHash1234567890";
    string public constant SOUL_HASH_2 = "QmTestHash0987654321";

    function setUp() public {
        vm.prank(owner);
        agentNFT = new TacticalAgentNFT(gameServer);

        vm.deal(userA, 1 ether);
        vm.deal(userB, 1 ether);
    }

    function test_MintAgent() public {
        vm.prank(userA);
        agentNFT.mintAgent{value: MINT_FEE}(SOUL_HASH);

        assertEq(agentNFT.ownerOf(0), userA);
        assertEq(agentNFT.soulHashes(0), SOUL_HASH);
        assertTrue(agentNFT.isAlive(0));
    }

    function test_RevertWhen_MintAgent_InsufficientFee() public {
        vm.prank(userA);
        vm.expectRevert("Insufficient mint fee");
        agentNFT.mintAgent{value: MINT_FEE - 1}(SOUL_HASH);
    }

    function test_BurnOnDeath() public {
        // userA mints
        vm.prank(userA);
        agentNFT.mintAgent{value: MINT_FEE}(SOUL_HASH);
        assertTrue(agentNFT.isAlive(0));

        // gameServer kills Agent 0
        vm.prank(gameServer);
        agentNFT.burnOnDeath(0);

        assertFalse(agentNFT.isAlive(0));
        assertEq(agentNFT.legacyOwners(0), userA); // Inheritance claim goes to userA

        // Verify it was actually burned (querying ownerOf reverts for burned tokens)
        vm.expectRevert();
        agentNFT.ownerOf(0);
    }

    function test_RevertWhen_BurnOnDeath_NotServer() public {
        vm.prank(userA);
        agentNFT.mintAgent{value: MINT_FEE}(SOUL_HASH);

        vm.prank(userA); // Unauthorized
        vm.expectRevert("Only server can kill");
        agentNFT.burnOnDeath(0);
    }

    function test_MintAgentWithInheritance() public {
        // Step 1: userA mints Agent 0
        vm.prank(userA);
        agentNFT.mintAgent{value: MINT_FEE}(SOUL_HASH);

        // Step 2: gameServer kills Agent 0
        vm.prank(gameServer);
        agentNFT.burnOnDeath(0);

        // Step 3: userA mints a new Agent (ID 1) inheriting from Agent 0
        vm.prank(userA);
        agentNFT.mintAgentWithInheritance{value: MINT_FEE}(SOUL_HASH_2, 0);

        assertEq(agentNFT.ownerOf(1), userA);
        assertEq(agentNFT.soulHashes(1), SOUL_HASH_2);
        assertTrue(agentNFT.isAlive(1));
        assertEq(agentNFT.parentOf(1), 0); // Correctly inherited
    }

    function test_RevertWhen_MintAgentWithInheritance_ParentAlive() public {
        vm.prank(userA);
        agentNFT.mintAgent{value: MINT_FEE}(SOUL_HASH);

        // Parent (Agent 0) is still alive, so inheritance should fail
        vm.prank(userA);
        vm.expectRevert("Parent must be dead to inherit");
        agentNFT.mintAgentWithInheritance{value: MINT_FEE}(SOUL_HASH_2, 0);
    }

    function test_RevertWhen_MintAgentWithInheritance_NotLegacyOwner() public {
        vm.prank(userA);
        agentNFT.mintAgent{value: MINT_FEE}(SOUL_HASH);

        vm.prank(gameServer);
        agentNFT.burnOnDeath(0);

        // userB tries to inherit userA's legacy, should fail
        vm.prank(userB);
        vm.expectRevert("Not the legacy owner of the parent");
        agentNFT.mintAgentWithInheritance{value: MINT_FEE}(SOUL_HASH_2, 0);
    }
}
