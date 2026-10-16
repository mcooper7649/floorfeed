// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FloorFeedDrop} from "../src/FloorFeedDrop.sol";
import {FloorFeedFactory} from "../src/FloorFeedFactory.sol";
import {FloorFeedStore} from "../src/FloorFeedStore.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract Rejecter {
    receive() external payable {
        revert("no");
    }
}

contract Reenter {
    FloorFeedDrop drop;
    constructor(FloorFeedDrop d) { drop = d; }
    receive() external payable {
        drop.withdraw(payable(address(this)));
    }
}

contract FloorFeedDropTest is Test {
    FloorFeedStore store;
    FloorFeedFactory factory;
    address admin = address(0xA11CE);
    address feeTo = address(0xFEE);
    address creator = address(0xC0FFEE);
    address alice = address(0xA1);
    address bob = address(0xB0B);
    uint256 constant FEE = 0.0001 ether;
    uint128 constant PRICE = 0.01 ether;

    function setUp() public {
        store = new FloorFeedStore();
        factory = new FloorFeedFactory(store, admin, FEE, feeTo);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.warp(1_800_000_000);
    }

    // Allowlist of alice + bob: leaf = keccak256(bytes.concat(keccak256(abi.encode(wallet)))).
    function _leaf(address w) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(w))));
    }
    function _root() internal view returns (bytes32) {
        (bytes32 a, bytes32 b) = (_leaf(alice), _leaf(bob));
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function _init(uint32 supply) internal view returns (FloorFeedDrop.Init memory p) {
        FloorFeedDrop.Phase[] memory ph = new FloorFeedDrop.Phase[](2);
        // phase 0: allowlist, 2 per wallet, half price, first hour
        ph[0] = FloorFeedDrop.Phase(uint64(block.timestamp), uint64(block.timestamp + 1 hours), PRICE / 2, 2, _root());
        // phase 1: public, 5 per wallet, opens after an hour
        ph[1] = FloorFeedDrop.Phase(uint64(block.timestamp + 1 hours), 0, PRICE, 5, bytes32(0));
        p = FloorFeedDrop.Init({
            name: "Floor Frogs", symbol: "FROG", contractURI: "ipfs://c", owner: address(0xBAD), // ignored: factory sets creator
            royaltyReceiver: creator, royaltyBps: 500, maxSupply: supply, placeholderURI: "ipfs://hidden.json",
            provenance: keccak256("art"), phases: ph
        });
    }

    function _launch(uint32 supply) internal returns (FloorFeedDrop d) {
        vm.prank(creator);
        d = FloorFeedDrop(factory.createCollection(bytes32("s1"), _init(supply)));
    }

    function test_createSetsCreatorAsOwnerAndLocksFee() public {
        FloorFeedDrop d = _launch(10);
        assertEq(d.owner(), creator);
        assertEq(d.mintFee(), FEE);
        assertEq(d.feeRecipient(), feeTo);
        assertEq(address(d), factory.predictAddress(creator, bytes32("s1")));
        vm.prank(admin);
        factory.setFee(1 ether, feeTo);
        assertEq(d.mintFee(), FEE, "existing collection keeps its fee");
        (address r, uint256 amt) = d.royaltyInfo(1, 10_000);
        assertEq(r, creator);
        assertEq(amt, 500);
    }

    function test_onlyAdminSetsFactoryFee() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        factory.setFee(0, alice);
    }

    function test_cannotReinitialize() public {
        FloorFeedDrop d = _launch(10);
        vm.expectRevert();
        d.initialize(_init(10), 0, alice);
    }

    function test_allowlistMintPaysCreatorAndFee() public {
        FloorFeedDrop d = _launch(10);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = _leaf(bob);
        uint256 cost = d.mintCost(0, 2);
        assertEq(cost, (PRICE / 2 + FEE) * 2);
        vm.prank(alice);
        d.mint{value: cost}(alice, 0, 2, proof);
        assertEq(d.ownerOf(1), alice);
        assertEq(d.ownerOf(2), alice);
        assertEq(d.totalMinted(), 2);
        assertEq(feeTo.balance, FEE * 2);
        assertEq(address(d).balance, uint256(PRICE)); // 2 × half price stays for the creator
    }

    function test_allowlistRejectsOthersAndLimits() public {
        FloorFeedDrop d = _launch(10);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = _leaf(bob);
        address eve = address(0xE5E);
        vm.deal(eve, 1 ether);
        uint256 c1 = d.mintCost(0, 1);
        vm.prank(eve);
        vm.expectRevert(FloorFeedDrop.NotAllowlisted.selector);
        d.mint{value: c1}(eve, 0, 1, proof);
        // a payer can't use someone else's allowlist spot to mint to themselves either
        uint256 c2 = d.mintCost(0, 1);
        vm.prank(eve);
        vm.expectRevert(FloorFeedDrop.NotAllowlisted.selector);
        d.mint{value: c2}(eve, 0, 1, proof);
        uint256 c3 = d.mintCost(0, 3);
        vm.prank(alice);
        vm.expectRevert(FloorFeedDrop.WalletLimit.selector);
        d.mint{value: c3}(alice, 0, 3, proof);
    }

    function test_payerCanMintForRecipient() public {
        FloorFeedDrop d = _launch(10);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = _leaf(alice);
        vm.prank(address(0xB1D9E)); // e.g. a bridge paying on bob's behalf
        vm.deal(address(0xB1D9E), 1 ether);
        uint256 c101 = d.mintCost(0, 1);
        d.mint{value: c101}(bob, 0, 1, proof);
        assertEq(d.ownerOf(1), bob);
        assertEq(d.mintedInPhase(0, bob), 1);
    }

    function test_phaseTiming() public {
        FloorFeedDrop d = _launch(10);
        bytes32[] memory none;
        uint256 c4 = d.mintCost(1, 1);
        vm.prank(alice);
        vm.expectRevert(FloorFeedDrop.PhaseNotActive.selector);
        d.mint{value: c4}(alice, 1, 1, none);
        vm.warp(block.timestamp + 1 hours);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = _leaf(bob);
        uint256 c102 = d.mintCost(0, 1);
        vm.prank(alice);
        vm.expectRevert(FloorFeedDrop.PhaseNotActive.selector); // allowlist closed
        d.mint{value: c102}(alice, 0, 1, proof);
        uint256 c103 = d.mintCost(1, 5);
        vm.prank(alice);
        d.mint{value: c103}(alice, 1, 5, none);
        uint256 c5 = d.mintCost(1, 1);
        vm.prank(alice);
        vm.expectRevert(FloorFeedDrop.WalletLimit.selector);
        d.mint{value: c5}(alice, 1, 1, none);
        vm.expectRevert(FloorFeedDrop.BadPhase.selector);
        d.mintCost(7, 1);
    }

    function test_exactPaymentOnly() public {
        FloorFeedDrop d = _launch(10);
        vm.warp(block.timestamp + 1 hours);
        bytes32[] memory none;
        uint256 cost = d.mintCost(1, 1);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(FloorFeedDrop.WrongPayment.selector, cost));
        d.mint{value: cost - 1}(alice, 1, 1, none);
        vm.expectRevert(abi.encodeWithSelector(FloorFeedDrop.WrongPayment.selector, cost));
        d.mint{value: cost + 1}(alice, 1, 1, none);
        vm.expectRevert(FloorFeedDrop.BadQuantity.selector);
        d.mint{value: 0}(alice, 1, 0, none);
        vm.stopPrank();
    }

    function test_soldOut() public {
        FloorFeedDrop d = _launch(3);
        vm.warp(block.timestamp + 1 hours);
        bytes32[] memory none;
        uint256 c6 = d.mintCost(1, 4);
        vm.prank(alice);
        vm.expectRevert(FloorFeedDrop.SoldOut.selector);
        d.mint{value: c6}(alice, 1, 4, none);
        uint256 c104 = d.mintCost(1, 3);
        vm.prank(alice);
        d.mint{value: c104}(alice, 1, 3, none);
        uint256 c7 = d.mintCost(1, 1);
        vm.prank(bob);
        vm.expectRevert(FloorFeedDrop.SoldOut.selector);
        d.mint{value: c7}(bob, 1, 1, none);
    }

    function test_supplyOnlyShrinks() public {
        FloorFeedDrop d = _launch(10);
        vm.warp(block.timestamp + 1 hours);
        bytes32[] memory none;
        uint256 c105 = d.mintCost(1, 4);
        vm.prank(alice);
        d.mint{value: c105}(alice, 1, 4, none);
        vm.startPrank(creator);
        vm.expectRevert(FloorFeedDrop.SupplyTooLow.selector);
        d.reduceSupply(11);
        vm.expectRevert(FloorFeedDrop.SupplyTooLow.selector);
        d.reduceSupply(3);
        d.reduceSupply(4);
        vm.stopPrank();
        assertEq(d.maxSupply(), 4);
    }

    function test_revealOffsetAndFreeze() public {
        FloorFeedDrop d = _launch(10);
        vm.warp(block.timestamp + 1 hours);
        bytes32[] memory none;
        uint256 c106 = d.mintCost(1, 5);
        vm.prank(alice);
        d.mint{value: c106}(alice, 1, 5, none);
        assertEq(d.tokenURI(1), "ipfs://hidden.json");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        d.reveal("ipfs://meta/");
        vm.prevrandao(bytes32(uint256(12345)));
        vm.roll(block.number + 5);
        vm.prank(creator);
        d.reveal("ipfs://meta/");
        uint256 idx = d.artworkOf(1);
        assertEq(idx, (uint256(d.startingIndex()) % 10) + 1);
        assertEq(d.tokenURI(1), string.concat("ipfs://meta/", vm.toString(idx), ".json"));
        // every token maps to a distinct artwork
        bool[11] memory seen;
        for (uint256 t = 1; t <= 5; ++t) {
            uint256 a = d.artworkOf(t);
            assertTrue(a >= 1 && a <= 10 && !seen[a]);
            seen[a] = true;
        }
        vm.startPrank(creator);
        vm.expectRevert(FloorFeedDrop.AlreadyRevealed.selector);
        d.reveal("ipfs://other/");
        d.setBaseURI("ipfs://meta2/");
        d.freezeMetadata();
        vm.expectRevert(FloorFeedDrop.Frozen.selector);
        d.setBaseURI("ipfs://evil/");
        vm.expectRevert(FloorFeedDrop.Frozen.selector);
        d.setPlaceholderURI("x");
        vm.stopPrank();
    }

    function test_reduceSupplyAfterRevealKeepsArt() public {
        FloorFeedDrop d = _launch(10);
        vm.warp(block.timestamp + 1 hours);
        bytes32[] memory none;
        uint256 c = d.mintCost(1, 3);
        vm.prank(alice);
        d.mint{value: c}(alice, 1, 3, none);
        vm.prevrandao(bytes32(uint256(777)));
        vm.prank(creator);
        d.reveal("ipfs://m/");
        uint256 a1 = d.artworkOf(1);
        uint256 a3 = d.artworkOf(3);
        vm.prank(creator);
        d.reduceSupply(3);
        assertEq(d.artworkOf(1), a1);
        assertEq(d.artworkOf(3), a3);
    }

    function test_withdrawOnlyOwnerAndProceedsOnly() public {
        FloorFeedDrop d = _launch(10);
        vm.warp(block.timestamp + 1 hours);
        bytes32[] memory none;
        uint256 c107 = d.mintCost(1, 2);
        vm.prank(alice);
        d.mint{value: c107}(alice, 1, 2, none);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        d.withdraw(payable(alice));
        uint256 before = creator.balance;
        vm.prank(creator);
        d.withdraw(payable(creator));
        assertEq(creator.balance - before, uint256(PRICE) * 2);
        assertEq(address(d).balance, 0);
    }

    function test_feeRecipientRevertBlocksMint() public {
        Rejecter r = new Rejecter();
        vm.prank(admin);
        factory.setFee(FEE, address(r));
        FloorFeedDrop d = _launch(10);
        vm.warp(block.timestamp + 1 hours);
        bytes32[] memory none;
        uint256 cost = d.mintCost(1, 1);
        vm.prank(alice);
        vm.expectRevert(FloorFeedDrop.FeeTransferFailed.selector);
        d.mint{value: cost}(alice, 1, 1, none);
    }

    function test_withdrawReentrancyBlocked() public {
        FloorFeedDrop d = _launch(10);
        Reenter re = new Reenter(d);
        vm.prank(creator);
        d.transferOwnership(address(re));
        vm.warp(block.timestamp + 1 hours);
        bytes32[] memory none;
        uint256 c108 = d.mintCost(1, 1);
        vm.prank(alice);
        d.mint{value: c108}(alice, 1, 1, none);
        vm.prank(address(re));
        vm.expectRevert(FloorFeedDrop.WithdrawFailed.selector); // inner call hits the guard, so the send fails
        d.withdraw(payable(address(re)));
    }

    function test_setPhasesValidation() public {
        FloorFeedDrop d = _launch(10);
        FloorFeedDrop.Phase[] memory bad = new FloorFeedDrop.Phase[](1);
        bad[0] = FloorFeedDrop.Phase(100, 50, 0, 0, bytes32(0));
        vm.prank(creator);
        vm.expectRevert(FloorFeedDrop.BadPhase.selector);
        d.setPhases(bad);
        FloorFeedDrop.Phase[] memory empty = new FloorFeedDrop.Phase[](0);
        vm.prank(creator);
        vm.expectRevert(FloorFeedDrop.BadPhase.selector);
        d.setPhases(empty);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        d.setPhases(bad);
    }

    function test_freeMintStillPaysFee() public {
        FloorFeedDrop.Init memory p = _init(10);
        p.phases[1].price = 0;
        vm.prank(creator);
        FloorFeedDrop d = FloorFeedDrop(factory.createCollection(bytes32("free"), p));
        vm.warp(block.timestamp + 1 hours);
        bytes32[] memory none;
        vm.prank(alice);
        d.mint{value: FEE}(alice, 1, 1, none);
        assertEq(feeTo.balance, FEE);
        assertEq(address(d).balance, 0);
    }

    function test_onChainRender() public {
        FloorFeedDrop d = _launch(1);
        bytes[] memory meta = new bytes[](1);
        meta[0] = bytes('{"name":"Frog #1","attributes":[]}');
        bytes[] memory media = new bytes[](1);
        media[0] = bytes("<svg/>");
        bytes32 m = store.store("application/json", meta);
        bytes32 i = store.store("image/svg+xml", media);
        bytes32[] memory ms = new bytes32[](1);
        bytes32[] memory is_ = new bytes32[](1);
        ms[0] = m;
        is_[0] = i;
        vm.prank(creator);
        d.setOnChainTokens(1, ms, is_);
        vm.warp(block.timestamp + 1 hours);
        bytes32[] memory none;
        uint256 c109 = d.mintCost(1, 1);
        vm.prank(alice);
        d.mint{value: c109}(alice, 1, 1, none);
        vm.prank(creator);
        d.reveal("");
        string memory uri = d.tokenURI(1);
        assertEq(bytes(uri).length > 30, true);
        // data:application/json;base64,... decodes to the spliced JSON with the image
        assertEq(_startsWith(uri, "data:application/json;base64,"), true);
    }

    function test_interfaces() public {
        FloorFeedDrop d = _launch(1);
        assertTrue(d.supportsInterface(0x80ac58cd)); // ERC-721
        assertTrue(d.supportsInterface(0x2a55205a)); // ERC-2981
        assertTrue(d.supportsInterface(0x49064906)); // ERC-4906
    }

    function testFuzz_mintAccounting(uint8 q1, uint8 q2) public {
        uint256 a = bound(q1, 1, 5);
        uint256 b = bound(q2, 1, 5);
        FloorFeedDrop d = _launch(10);
        vm.warp(block.timestamp + 1 hours);
        bytes32[] memory none;
        uint256 c110 = d.mintCost(1, a);
        vm.prank(alice);
        d.mint{value: c110}(alice, 1, a, none);
        uint256 c111 = d.mintCost(1, b);
        vm.prank(bob);
        d.mint{value: c111}(bob, 1, b, none);
        assertEq(d.totalMinted(), a + b);
        assertEq(feeTo.balance, FEE * (a + b));
        assertEq(address(d).balance, uint256(PRICE) * (a + b));
        assertEq(d.balanceOf(alice), a);
        assertEq(d.ownerOf(a + b), bob);
    }

    function _startsWith(string memory s, string memory p) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(p);
        if (a.length < b.length) return false;
        for (uint256 i; i < b.length; ++i) if (a[i] != b[i]) return false;
        return true;
    }
}
