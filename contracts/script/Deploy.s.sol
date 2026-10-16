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
contract Deploy is Script {
    bytes32 constant SALT = keccak256("floorfeed.launchpad.v1");
    uint256 constant DEFAULT_FEE = 0.0001 ether;

    function run() external {
        address owner = vm.envAddress("FF_OWNER");
        address feeTo = vm.envAddress("FF_FEE_TO");
        uint256 fee = vm.envOr("FF_FEE", DEFAULT_FEE);

        address storeAddr = vm.computeCreate2Address(SALT, keccak256(type(FloorFeedStore).creationCode));
        bytes memory factoryInit = abi.encodePacked(
            type(FloorFeedFactory).creationCode, abi.encode(FloorFeedStore(storeAddr), owner, DEFAULT_FEE, feeTo)
        );
        address factoryAddr = vm.computeCreate2Address(SALT, keccak256(factoryInit));

        vm.startBroadcast();
        if (storeAddr.code.length == 0) new FloorFeedStore{salt: SALT}();
        if (factoryAddr.code.length == 0) new FloorFeedFactory{salt: SALT}(FloorFeedStore(storeAddr), owner, DEFAULT_FEE, feeTo);
        FloorFeedFactory factory = FloorFeedFactory(factoryAddr);
        if (factory.mintFee() != fee || factory.feeRecipient() != feeTo) factory.setFee(fee, feeTo);
        vm.stopBroadcast();

        console.log("store", storeAddr);
        console.log("factory", factoryAddr);
        console.log("implementation", factory.implementation());
        console.log("mintFee", factory.mintFee());
    }
}
