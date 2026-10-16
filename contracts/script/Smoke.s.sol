// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {FloorFeedDrop} from "../src/FloorFeedDrop.sol";
import {FloorFeedFactory} from "../src/FloorFeedFactory.sol";

/// End-to-end on a fork: launch a collection, mint, reveal, read tokenURI.
contract Smoke is Script {
    function run(address factoryAddr) external {
        FloorFeedFactory factory = FloorFeedFactory(factoryAddr);
        FloorFeedDrop.Phase[] memory ph = new FloorFeedDrop.Phase[](1);
        ph[0] = FloorFeedDrop.Phase(uint64(block.timestamp - 1), 0, 0.001 ether, 5, bytes32(0));
        FloorFeedDrop.Init memory p = FloorFeedDrop.Init({
            name: "Smoke", symbol: "SMK", contractURI: "ipfs://c", owner: address(0), royaltyReceiver: msg.sender,
            royaltyBps: 500, maxSupply: 100, placeholderURI: "ipfs://hidden", provenance: bytes32(0), phases: ph
        });
        vm.startBroadcast();
        FloorFeedDrop d = FloorFeedDrop(factory.createCollection(keccak256(abi.encode(block.timestamp)), p));
        uint256 cost = d.mintCost(0, 3);
        d.mint{value: cost}(msg.sender, 0, 3, new bytes32[](0));
        d.reveal("ipfs://meta/");
        vm.stopBroadcast();
        console.log("collection", address(d));
        console.log("owner ok", d.owner() == msg.sender);
        console.log("minted", d.totalMinted());
        console.log("tokenURI(1)", d.tokenURI(1));
    }
}
