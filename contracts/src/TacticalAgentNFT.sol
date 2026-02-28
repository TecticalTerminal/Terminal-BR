// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TacticalAgentNFT
 * @dev 虎虎负责：支持创建收费、灵魂哈希绑定、死亡销毁、以及上一代资产继承机制
 */
contract TacticalAgentNFT is ERC721, Ownable {
    uint256 private _nextTokenId;
    uint256 public constant MINT_FEE = 0.01 ether;

    mapping(uint256 => string) public soulHashes;
    mapping(uint256 => bool) public isAlive;
    
    // 继承机制
    mapping(uint256 => address) public legacyOwners; // 记录死去 Agent 的最终所有者，作为继承权凭证
    mapping(uint256 => uint256) public parentOf;     // 记录继承关系：当前 Agent ID -> 父代 Agent ID

    address public gameServer;

    event AgentBorn(uint256 indexed tokenId, string soulHash, uint256 parentId);
    event AgentDied(uint256 indexed tokenId, address legacyOwner);

    constructor(address _gameServer) ERC721("TacticalAgent", "TAG") Ownable(msg.sender) {
        gameServer = _gameServer;
    }

    // 1. 常规创建 Agent (无继承)
    function mintAgent(string memory _soulHash) external payable {
        require(msg.value >= MINT_FEE, "Insufficient mint fee");
        
        uint256 tokenId = _nextTokenId++;
        _safeMint(msg.sender, tokenId);
        
        soulHashes[tokenId] = _soulHash;
        isAlive[tokenId] = true;

        // parentId=0 表示初代 Agent
        emit AgentBorn(tokenId, _soulHash, 0); 
    }

    // 2. 继承创建 Agent
    function mintAgentWithInheritance(string memory _soulHash, uint256 _parentId) external payable {
        require(msg.value >= MINT_FEE, "Insufficient mint fee");
        require(!isAlive[_parentId], "Parent must be dead to inherit");
        require(legacyOwners[_parentId] == msg.sender, "Not the legacy owner of the parent"); // 只有前主能继承
        
        uint256 tokenId = _nextTokenId++;
        _safeMint(msg.sender, tokenId);
        
        soulHashes[tokenId] = _soulHash;
        isAlive[tokenId] = true;
        parentOf[tokenId] = _parentId;

        emit AgentBorn(tokenId, _soulHash, _parentId);
    }

    // 3. 死亡销毁并保留继承权
    function burnOnDeath(uint256 tokenId) external {
        require(msg.sender == gameServer, "Only server can kill");
        require(isAlive[tokenId], "Agent already dead");

        isAlive[tokenId] = false;
        
        // 记录遗产权归属（当前 Owner）
        legacyOwners[tokenId] = ownerOf(tokenId); 

        _burn(tokenId); // 彻底从链上抹除

        emit AgentDied(tokenId, legacyOwners[tokenId]);
    }

    // 4. 修改服务器地址
    function setGameServer(address _newServer) external onlyOwner {
        gameServer = _newServer;
    }
}
