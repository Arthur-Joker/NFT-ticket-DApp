// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface ITicket {
    function mint() external returns (uint256);
}

contract ToggleReceiver {
    bool public accepts;

    function setAccepts(bool value) external { accepts = value; }
    function claim(address ticket) external { ITicket(ticket).mint(); }
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        require(accepts, "Receiver rejected");
        return this.onERC721Received.selector;
    }
}

contract ReentrantReceiver {
    bool public secondClaimRejected;

    function claim(address ticket) external { ITicket(ticket).mint(); }
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        try ITicket(msg.sender).mint() { revert("Unexpected second mint"); }
        catch { secondClaimRejected = true; }
        return this.onERC721Received.selector;
    }
}
