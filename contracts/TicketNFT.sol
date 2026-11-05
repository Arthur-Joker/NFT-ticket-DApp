// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// The versioned import works directly in Remix. The local compiler resolves it
// to the same pinned npm dependency (see scripts/compile-contract.mjs).
import {ERC721} from "@openzeppelin/contracts@5.6.1/token/ERC721/ERC721.sol";

/// @notice A free NFT ticket. Each address can claim once, even after transfer.
contract TicketNFT is ERC721 {
    uint256 private _nextTokenId = 1;
    mapping(address => bool) public hasMinted;

    event Mint(address indexed minter, uint256 indexed tokenId);

    constructor() ERC721("Ticket NFT", "TICKET") {}

    function mint() external returns (uint256 tokenId) {
        require(!hasMinted[msg.sender], "One ticket per wallet");

        tokenId = _nextTokenId++;
        // Record the claim before the receiver callback; a failed mint rolls
        // back both this flag and the token ID in the same transaction.
        hasMinted[msg.sender] = true;
        _safeMint(msg.sender, tokenId);

        emit Mint(msg.sender, tokenId);
    }
}
