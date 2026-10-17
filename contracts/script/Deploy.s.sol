// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {FloorFeedFactory} from "../src/FloorFeedFactory.sol";
import {FloorFeedStore} from "../src/FloorFeedStore.sol";

/// Deploys FloorFeedStore + FloorFeedFactory through the CREATE2 deployer, so both have
/// the same address on every chain (constructor args are the same everywhere; the per-chain
/// fee is set afterwards). Idempotent: skips what's already there.
///   FF_OWNER       factory owner (sets fees); must be the broadcaster to apply FF_FEE
///   FF_FEE_TO      fee recipient
///   FF_FEE         this chain's fee per minted token, in native wei
///   FF_EXEMPT      optional comma-separated creators who launch fee-free
///   FF_FINAL_OWNER optional: hand ownership to this address at the end
///   FF_PASS_SIGNER FloorFeed's member-pass signer (part of the CREATE2 address, so the same everywhere)
contract Deploy is Script {
    bytes32 constant SALT = keccak256("floorfeed.launchpad.v1");
    uint256 constant DEFAULT_FEE = 0.0001 ether;

    function run() external {
        address owner = vm.envAddress("FF_OWNER");
        address feeTo = vm.envAddress("FF_FEE_TO");
        uint256 fee = vm.envOr("FF_FEE", DEFAULT_FEE);
        address passSigner = vm.envAddress("FF_PASS_SIGNER");

        address storeAddr = vm.computeCreate2Address(SALT, keccak256(type(FloorFeedStore).creationCode));
        bytes memory factoryInit = abi.encodePacked(
            type(FloorFeedFactory).creationCode, abi.encode(FloorFeedStore(storeAddr), owner, DEFAULT_FEE, feeTo, passSigner)
        );
        address factoryAddr = vm.computeCreate2Address(SALT, keccak256(factoryInit));

        vm.startBroadcast();
        if (storeAddr.code.length == 0) new FloorFeedStore{salt: SALT}();
        if (factoryAddr.code.length == 0) new FloorFeedFactory{salt: SALT}(FloorFeedStore(storeAddr), owner, DEFAULT_FEE, feeTo, passSigner);
        FloorFeedFactory factory = FloorFeedFactory(factoryAddr);
        if (factory.mintFee() != fee || factory.feeRecipient() != feeTo) factory.setFee(fee, feeTo);
        address[] memory exempt = vm.envOr("FF_EXEMPT", ",", new address[](0));
        address[] memory toSet = new address[](exempt.length);
        uint256 n;
        for (uint256 i; i < exempt.length; ++i) if (!factory.feeExempt(exempt[i])) toSet[n++] = exempt[i];
        assembly { mstore(toSet, n) }
        if (n != 0) factory.setFeeExempt(toSet, true);
        address finalOwner = vm.envOr("FF_FINAL_OWNER", address(0));
        if (finalOwner != address(0) && factory.owner() != finalOwner) factory.transferOwnership(finalOwner);
        vm.stopBroadcast();

        console.log("store", storeAddr);
        console.log("factory", factoryAddr);
        console.log("implementation", factory.implementation());
        console.log("mintFee", factory.mintFee());
        console.log("passSigner", factory.passSigner());
    }
}
