// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// Stand-in for the ERC-8004 IdentityRegistry (an ERC-721). Only ownerOf/transfer matter to MemoryRegistry.
contract MockIdentity is ERC721("AgentIdentity", "AGENT") {
    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}
