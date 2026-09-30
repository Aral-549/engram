// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {MemoryRegistry} from "engram/MemoryRegistry.sol";

/// Deploys MemoryRegistry against the canonical ERC-8004 IdentityRegistry for the target chain and
/// records the address in deployments/<chainId>.json (read by the SDK, indexer, and apps).
///
///   forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast --private-key $DEPLOYER_PRIVATE_KEY
contract Deploy is Script {
    address constant IDENTITY_TESTNET = 0x8004A818BFB912233c491871b3d84c89A494BD9e; // chain 10143
    address constant IDENTITY_MAINNET = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432; // chain 143

    function run() external returns (MemoryRegistry reg) {
        address identity = vm.envOr("IDENTITY_REGISTRY", _canonicalIdentity());
        require(identity.code.length > 0, "identity registry has no code on this chain");

        vm.startBroadcast();
        reg = new MemoryRegistry(identity);
        vm.stopBroadcast();

        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "identityRegistry", identity);
        vm.serializeUint(json, "deployBlock", block.number);
        string memory out = vm.serializeAddress(json, "memoryRegistry", address(reg));
        vm.writeJson(out, string.concat("deployments/", vm.toString(block.chainid), ".json"));
        console.log("MemoryRegistry", address(reg));
    }

    function _canonicalIdentity() private view returns (address) {
        if (block.chainid == 10143) return IDENTITY_TESTNET;
        if (block.chainid == 143) return IDENTITY_MAINNET;
        return address(0);
    }
}
