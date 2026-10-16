// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {FloorFeedDrop} from "./FloorFeedDrop.sol";
import {FloorFeedStore} from "./FloorFeedStore.sol";

/// @title FloorFeedFactory
/// @notice Launches FloorFeedDrop collections as ERC-1167 clones. The creator's wallet
/// sends the deploy and owns the collection; FloorFeed only sets the per-token fee that
/// new collections lock in (existing collections keep the fee they launched with), and which
/// creators launch fee-free.
contract FloorFeedFactory is Ownable {
    address public immutable implementation;
    uint256 public mintFee; // native wei per minted token, for collections created from now on
    address public feeRecipient;
    mapping(address creator => bool) public feeExempt; // collections they launch lock in a fee of 0

    event CollectionCreated(address indexed creator, address indexed collection, string name, string symbol, uint256 mintFee);
    event FeeUpdated(uint256 mintFee, address feeRecipient);
    event FeeExemptSet(address indexed creator, bool exempt);

    error ZeroRecipient();

    constructor(FloorFeedStore store, address owner_, uint256 mintFee_, address feeRecipient_) Ownable(owner_) {
        implementation = address(new FloorFeedDrop(store));
        _setFee(mintFee_, feeRecipient_);
    }

    function createCollection(bytes32 salt, FloorFeedDrop.Init calldata p) external returns (address collection) {
        collection = Clones.cloneDeterministic(implementation, _salt(msg.sender, salt));
        FloorFeedDrop.Init memory init = p;
        init.owner = msg.sender; // the creator always owns what they launch
        uint256 fee = feeOf(msg.sender);
        FloorFeedDrop(collection).initialize(init, fee, feeRecipient);
        emit CollectionCreated(msg.sender, collection, p.name, p.symbol, fee);
    }

    function predictAddress(address creator, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(creator, salt));
    }

    /// @notice The per-token fee a collection launched by `creator` would lock in right now.
    function feeOf(address creator) public view returns (uint256) {
        return feeExempt[creator] ? 0 : mintFee;
    }

    function setFeeExempt(address[] calldata creators, bool exempt) external onlyOwner {
        for (uint256 i; i < creators.length; ++i) {
            feeExempt[creators[i]] = exempt;
            emit FeeExemptSet(creators[i], exempt);
        }
    }

    function setFee(uint256 mintFee_, address feeRecipient_) external onlyOwner {
        _setFee(mintFee_, feeRecipient_);
    }

    function _setFee(uint256 mintFee_, address feeRecipient_) private {
        if (feeRecipient_ == address(0)) revert ZeroRecipient();
        mintFee = mintFee_;
        feeRecipient = feeRecipient_;
        emit FeeUpdated(mintFee_, feeRecipient_);
    }

    /// Salt is namespaced by creator so nobody can take someone else's predicted address.
    function _salt(address creator, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }
}
