// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract PredictionMarket {
  error Unauthorized();
  error InvalidRound();
  error InvalidGameId();
  error InvalidOutcome();
  error InvalidLockTime();
  error InvalidAddress();
  error InvalidAmount();
  error RoundAlreadyOpened();
  error RoundClosed();
  error RoundNotClosed();
  error RoundAlreadyResolved();
  error RoundNotResolved();
  error AlreadyClaimed();
  error NothingToClaim();
  error TransferFailed();
  error ReentrancyGuard();

  struct Round {
    bytes32 gameIdHash;
    uint64 lockAt;
    uint64 resolvedAt;
    bytes32 winnerOutcome;
    uint256 totalPool;
    uint256 distributablePool;
    uint256 winnerPool;
    bool resolved;
  }

  address public owner;
  address public resolver;

  uint256 public nextRoundId = 1;
  uint256 public pendingTreasury; // 5% pool
  uint256 public pendingCreatorTreasury; // 1% pool

  uint256 private _locked = 1;

  mapping(uint256 => Round) public rounds;
  mapping(bytes32 => uint256) public roundIdByGame;
  mapping(uint256 => mapping(bytes32 => uint256)) public outcomePool;
  mapping(uint256 => mapping(address => mapping(bytes32 => uint256))) public userStakeByOutcome;
  mapping(uint256 => mapping(address => bool)) public claimed;

  event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
  event ResolverUpdated(address indexed previousResolver, address indexed newResolver);

  event RoundOpened(uint256 indexed roundId, bytes32 indexed gameIdHash, uint64 lockAt);
  event BetPlaced(
    uint256 indexed roundId,
    address indexed user,
    bytes32 indexed outcome,
    uint256 amount,
    uint256 totalPool
  );
  event RoundResolved(
    uint256 indexed roundId,
    bytes32 indexed winnerOutcome,
    uint256 winnerPool,
    uint256 distributablePool,
    uint256 feeAmount // Total fees (5% + 1%)
  );
  event Claimed(uint256 indexed roundId, address indexed user, uint256 payout);
  event TreasuryWithdrawn(address indexed to, uint256 amount);
  event CreatorTreasuryWithdrawn(address indexed to, uint256 amount);

  modifier onlyOwner() {
    if (msg.sender != owner) revert Unauthorized();
    _;
  }

  modifier onlyResolver() {
    if (msg.sender != resolver && msg.sender != owner) revert Unauthorized();
    _;
  }

  modifier nonReentrant() {
    if (_locked != 1) revert ReentrancyGuard();
    _locked = 2;
    _;
    _locked = 1;
  }

  constructor(address initialResolver) {
    if (initialResolver == address(0)) revert InvalidAddress();

    owner = msg.sender;
    resolver = initialResolver;

    emit OwnershipTransferred(address(0), msg.sender);
    emit ResolverUpdated(address(0), initialResolver);
  }

  function transferOwnership(address newOwner) external onlyOwner {
    if (newOwner == address(0)) revert InvalidAddress();
    address previousOwner = owner;
    owner = newOwner;
    emit OwnershipTransferred(previousOwner, newOwner);
  }

  function setResolver(address newResolver) external onlyOwner {
    if (newResolver == address(0)) revert InvalidAddress();
    address previousResolver = resolver;
    resolver = newResolver;
    emit ResolverUpdated(previousResolver, newResolver);
  }

  function openRound(bytes32 gameIdHash, uint64 lockAt) external onlyResolver returns (uint256 roundId) {
    if (gameIdHash == bytes32(0)) revert InvalidGameId();
    if (lockAt <= block.timestamp) revert InvalidLockTime();
    if (roundIdByGame[gameIdHash] != 0) revert RoundAlreadyOpened();

    roundId = nextRoundId;
    unchecked {
      nextRoundId = roundId + 1;
    }

    rounds[roundId].gameIdHash = gameIdHash;
    rounds[roundId].lockAt = lockAt;
    roundIdByGame[gameIdHash] = roundId;

    emit RoundOpened(roundId, gameIdHash, lockAt);
  }

  function placeBet(uint256 roundId, bytes32 outcome) external payable nonReentrant {
    if (msg.value == 0) revert InvalidAmount();
    if (outcome == bytes32(0)) revert InvalidOutcome();

    Round storage round = rounds[roundId];
    if (round.gameIdHash == bytes32(0)) revert InvalidRound();
    if (round.resolved) revert RoundAlreadyResolved();
    if (block.timestamp >= round.lockAt) revert RoundClosed();

    outcomePool[roundId][outcome] += msg.value;
    userStakeByOutcome[roundId][msg.sender][outcome] += msg.value;
    round.totalPool += msg.value;

    emit BetPlaced(roundId, msg.sender, outcome, msg.value, round.totalPool);
  }

  function resolveRound(uint256 roundId, bytes32 winnerOutcome) external onlyResolver {
    if (winnerOutcome == bytes32(0)) revert InvalidOutcome();

    Round storage round = rounds[roundId];
    if (round.gameIdHash == bytes32(0)) revert InvalidRound();
    if (round.resolved) revert RoundAlreadyResolved();
    if (block.timestamp < round.lockAt) revert RoundNotClosed();

    uint256 totalPool = round.totalPool;
    // Applied 94 / 5 / 1 Rules
    uint256 treasuryAmount = (totalPool * 5) / 100;
    uint256 creatorAmount = (totalPool * 1) / 100;
    uint256 distributable = totalPool - treasuryAmount - creatorAmount;
    uint256 winnerPool = outcomePool[roundId][winnerOutcome];

    round.resolved = true;
    round.resolvedAt = uint64(block.timestamp);
    round.winnerOutcome = winnerOutcome;

    if (winnerPool == 0) {
      pendingTreasury += totalPool; // If no payout, all goes to main treasury
      round.distributablePool = 0;
      round.winnerPool = 0;
    } else {
      pendingTreasury += treasuryAmount;
      pendingCreatorTreasury += creatorAmount;
      round.distributablePool = distributable;
      round.winnerPool = winnerPool;
    }

    emit RoundResolved(roundId, winnerOutcome, winnerPool, round.distributablePool, treasuryAmount + creatorAmount);
  }

  function previewClaim(uint256 roundId, address user) public view returns (uint256) {
    Round storage round = rounds[roundId];
    if (round.gameIdHash == bytes32(0) || !round.resolved) return 0;
    if (round.winnerPool == 0) return 0;

    uint256 stake = userStakeByOutcome[roundId][user][round.winnerOutcome];
    if (stake == 0) return 0;

    return (stake * round.distributablePool) / round.winnerPool;
  }

  function claim(uint256 roundId) external nonReentrant returns (uint256 payout) {
    Round storage round = rounds[roundId];
    if (round.gameIdHash == bytes32(0)) revert InvalidRound();
    if (!round.resolved) revert RoundNotResolved();
    if (claimed[roundId][msg.sender]) revert AlreadyClaimed();

    payout = previewClaim(roundId, msg.sender);
    if (payout == 0) revert NothingToClaim();

    claimed[roundId][msg.sender] = true;
    _sendValue(payable(msg.sender), payout);

    emit Claimed(roundId, msg.sender, payout);
  }

  function withdrawTreasury(address payable to, uint256 amount) external onlyOwner nonReentrant {
    if (to == address(0)) revert InvalidAddress();
    if (amount == 0 || amount > pendingTreasury) revert InvalidAmount();

    pendingTreasury -= amount;
    _sendValue(to, amount);

    emit TreasuryWithdrawn(to, amount);
  }

  function withdrawCreatorTreasury(address payable to, uint256 amount) external onlyOwner nonReentrant {
    if (to == address(0)) revert InvalidAddress();
    if (amount == 0 || amount > pendingCreatorTreasury) revert InvalidAmount();

    pendingCreatorTreasury -= amount;
    _sendValue(to, amount);

    emit CreatorTreasuryWithdrawn(to, amount);
  }

  function _sendValue(address payable to, uint256 amount) internal {
    (bool ok, ) = to.call{value: amount}("");
    if (!ok) revert TransferFailed();
  }
}
