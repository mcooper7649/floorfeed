// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {ERC2981Upgradeable} from "@openzeppelin/contracts-upgradeable/token/common/ERC2981Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {FloorFeedStore} from "./FloorFeedStore.sol";

/// @title FloorFeedDrop
/// @notice A creator's PFP collection launched on FloorFeed: a fixed set of unique tokens
/// minted in order through up to a few phases (allowlist, public...), revealed once the
/// creator is ready. Metadata lives on IPFS (baseURI + index + ".json") or fully on chain
/// in FloorFeedStore. Deployed as an ERC-1167 clone by FloorFeedFactory.
///
/// Collector protections, enforced here rather than promised:
/// - supply can only go down, never up;
/// - the FloorFeed fee per token is fixed when the collection is created;
/// - metadata can be frozen for good;
/// - a reveal shuffles which artwork each token gets with an offset nobody knows in
///   advance, so the creator can't steer rare pieces to particular token ids.
contract FloorFeedDrop is ERC721Upgradeable, ERC2981Upgradeable, OwnableUpgradeable, ReentrancyGuard {
    using Strings for uint256;

    struct Phase {
        uint64 start; // unix seconds
        uint64 end; // unix seconds, 0 = open until sold out
        uint128 price; // native wei per token, paid to the creator
        uint32 maxPerWallet; // 0 = no limit
        bytes32 merkleRoot; // 0 = public; leaf = keccak256(bytes.concat(keccak256(abi.encode(wallet))))
    }

    struct Init {
        string name;
        string symbol;
        string contractURI;
        address owner;
        address royaltyReceiver;
        uint96 royaltyBps;
        uint32 maxSupply;
        string placeholderURI; // shown for every token until reveal
        bytes32 provenance; // hash of the ordered artwork, published before mint (optional)
        Phase[] phases;
    }

    /// On-chain token: metadata JSON (no image field) + media, both in FloorFeedStore.
    struct OnChainToken {
        bytes32 metaFile;
        bytes32 mediaFile;
    }

    uint256 public constant MAX_PHASES = 8;
    uint256 public constant MAX_PER_TX = 50;

    FloorFeedStore public immutable STORE;

    // Fixed at creation.
    uint256 public mintFee; // per token, native wei, to feeRecipient
    address public feeRecipient;
    bytes32 public provenance;

    uint32 public maxSupply;
    uint32 public totalMinted;
    uint32 public startingIndex; // set at reveal
    uint32 public revealSupply; // supply the artwork mapping uses, fixed at reveal
    bool public revealed;
    bool public metadataFrozen;

    string private _contractURI;
    string public placeholderURI;
    string public baseURI;
    Phase[] private _phases;
    mapping(uint256 phase => mapping(address wallet => uint256)) public mintedInPhase;
    mapping(uint256 index => OnChainToken) public onChainToken; // by artwork index (1-based)

    event Minted(address indexed payer, address indexed to, uint256 indexed phase, uint256 firstTokenId, uint256 quantity);
    event PhasesUpdated();
    event Revealed(string baseURI, uint256 startingIndex);
    event MetadataFrozen();
    event SupplyReduced(uint256 maxSupply);
    event ContractURIUpdated();
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId); // ERC-4906

    error BadPhase();
    error PhaseNotActive();
    error SoldOut();
    error BadQuantity();
    error WalletLimit();
    error NotAllowlisted();
    error WrongPayment(uint256 expected);
    error FeeTransferFailed();
    error WithdrawFailed();
    error Frozen();
    error AlreadyRevealed();
    error NotRevealed();
    error SupplyTooLow();
    error LengthMismatch();

    constructor(FloorFeedStore store_) {
        STORE = store_;
        _disableInitializers();
    }

    function initialize(Init calldata p, uint256 mintFee_, address feeRecipient_) external initializer {
        if (p.maxSupply == 0) revert SupplyTooLow();
        __ERC721_init(p.name, p.symbol);
        __ERC2981_init();
        __Ownable_init(p.owner);
        if (p.royaltyBps > 0) _setDefaultRoyalty(p.royaltyReceiver, p.royaltyBps);
        _contractURI = p.contractURI;
        placeholderURI = p.placeholderURI;
        provenance = p.provenance;
        maxSupply = p.maxSupply;
        mintFee = mintFee_;
        feeRecipient = feeRecipient_;
        _setPhases(p.phases);
    }

    // --- minting ---

    /// @notice Mint `quantity` tokens in phase `phase` to `to`. Anyone may pay (so a bridge
    /// or a friend can mint for you); allowlists and wallet limits apply to `to`.
    function mint(address to, uint256 phase, uint256 quantity, bytes32[] calldata proof) external payable nonReentrant {
        if (phase >= _phases.length) revert BadPhase();
        Phase memory ph = _phases[phase];
        if (block.timestamp < ph.start || (ph.end != 0 && block.timestamp >= ph.end)) revert PhaseNotActive();
        if (quantity == 0 || quantity > MAX_PER_TX) revert BadQuantity();
        if (uint256(totalMinted) + quantity > maxSupply) revert SoldOut();
        if (ph.merkleRoot != bytes32(0)) {
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(to))));
            if (!MerkleProof.verifyCalldata(proof, ph.merkleRoot, leaf)) revert NotAllowlisted();
        }
        uint256 already = mintedInPhase[phase][to];
        if (ph.maxPerWallet != 0 && already + quantity > ph.maxPerWallet) revert WalletLimit();
        uint256 fee = mintFee * quantity;
        uint256 expected = uint256(ph.price) * quantity + fee;
        if (msg.value != expected) revert WrongPayment(expected);

        mintedInPhase[phase][to] = already + quantity;
        uint256 first = uint256(totalMinted) + 1;
        totalMinted = uint32(first - 1 + quantity);
        for (uint256 i; i < quantity; ++i) _mint(to, first + i);
        emit Minted(msg.sender, to, phase, first, quantity);

        if (fee != 0) {
            (bool ok,) = feeRecipient.call{value: fee}("");
            if (!ok) revert FeeTransferFailed();
        }
    }

    /// @notice What a mint costs in total (creator price + FloorFeed fee).
    function mintCost(uint256 phase, uint256 quantity) external view returns (uint256) {
        if (phase >= _phases.length) revert BadPhase();
        return (uint256(_phases[phase].price) + mintFee) * quantity;
    }

    // --- creator controls ---

    function setPhases(Phase[] calldata phases_) external onlyOwner {
        _setPhases(phases_);
    }

    /// @notice Supply can only shrink (and never below what's minted): collectors never get diluted.
    function reduceSupply(uint32 newMax) external onlyOwner {
        if (newMax >= maxSupply || newMax < totalMinted) revert SupplyTooLow();
        maxSupply = newMax;
        emit SupplyReduced(newMax);
    }

    /// @notice Reveal: point at the real metadata and roll the starting offset. Once only.
    function reveal(string calldata baseURI_) external onlyOwner {
        if (revealed) revert AlreadyRevealed();
        if (metadataFrozen) revert Frozen();
        revealed = true;
        baseURI = baseURI_;
        revealSupply = maxSupply;
        // prevrandao + the previous block hash: unknowable when the collection launched.
        startingIndex = uint32(uint256(keccak256(abi.encode(block.prevrandao, blockhash(block.number - 1), address(this)))) % maxSupply);
        emit Revealed(baseURI_, startingIndex);
        emit BatchMetadataUpdate(1, type(uint256).max);
    }

    /// @notice Fix a broken link after reveal (e.g. re-pinned metadata) until frozen.
    function setBaseURI(string calldata baseURI_) external onlyOwner {
        if (metadataFrozen) revert Frozen();
        if (!revealed) revert NotRevealed();
        baseURI = baseURI_;
        emit BatchMetadataUpdate(1, type(uint256).max);
    }

    function setPlaceholderURI(string calldata uri) external onlyOwner {
        if (metadataFrozen) revert Frozen();
        placeholderURI = uri;
        emit BatchMetadataUpdate(1, type(uint256).max);
    }

    /// @notice On-chain metadata for artwork indexes `firstIndex`..: files must already be in STORE.
    function setOnChainTokens(uint256 firstIndex, bytes32[] calldata metaFiles, bytes32[] calldata mediaFiles) external onlyOwner {
        if (metadataFrozen) revert Frozen();
        if (metaFiles.length != mediaFiles.length || firstIndex == 0) revert LengthMismatch();
        for (uint256 i; i < metaFiles.length; ++i) {
            onChainToken[firstIndex + i] = OnChainToken(metaFiles[i], mediaFiles[i]);
        }
        if (revealed) emit BatchMetadataUpdate(1, type(uint256).max);
    }

    function freezeMetadata() external onlyOwner {
        if (!revealed) revert NotRevealed();
        metadataFrozen = true;
        emit MetadataFrozen();
    }

    function setContractURI(string calldata uri) external onlyOwner {
        _contractURI = uri;
        emit ContractURIUpdated();
    }

    function setDefaultRoyalty(address receiver, uint96 bps) external onlyOwner {
        _setDefaultRoyalty(receiver, bps);
    }

    /// @notice Send mint proceeds (everything but FloorFeed's fee, which never stays here) to `to`.
    function withdraw(address payable to) external onlyOwner nonReentrant {
        (bool ok,) = to.call{value: address(this).balance}("");
        if (!ok) revert WithdrawFailed();
    }

    // --- views ---

    function phases() external view returns (Phase[] memory) {
        return _phases;
    }

    function contractURI() external view returns (string memory) {
        return _contractURI;
    }

    /// @notice Which artwork (1-based index into the uploaded set) a token shows after reveal.
    function artworkOf(uint256 tokenId) public view returns (uint256) {
        _requireOwned(tokenId);
        if (!revealed) return 0;
        return ((tokenId - 1 + startingIndex) % revealSupply) + 1;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        if (!revealed) return placeholderURI;
        uint256 index = artworkOf(tokenId);
        OnChainToken memory t = onChainToken[index];
        if (t.metaFile != bytes32(0)) return _renderOnChain(t);
        return string.concat(baseURI, index.toString(), ".json");
    }

    function _renderOnChain(OnChainToken memory t) internal view returns (string memory) {
        bytes memory meta = STORE.read(t.metaFile);
        (string memory mime,,) = STORE.info(t.mediaFile);
        string memory image = string.concat("data:", mime, ";base64,", Base64.encode(STORE.read(t.mediaFile)));
        // Splice the image into the JSON object: meta is `{...}` without an image field.
        bytes memory head = new bytes(meta.length - 1);
        for (uint256 i; i < head.length; ++i) head[i] = meta[i];
        string memory json = string.concat(string(head), ',"image":"', image, '"}');
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721Upgradeable, ERC2981Upgradeable) returns (bool) {
        return interfaceId == 0x49064906 || super.supportsInterface(interfaceId); // ERC-4906
    }

    function _setPhases(Phase[] calldata phases_) internal {
        if (phases_.length == 0 || phases_.length > MAX_PHASES) revert BadPhase();
        delete _phases;
        for (uint256 i; i < phases_.length; ++i) {
            Phase calldata ph = phases_[i];
            if (ph.end != 0 && ph.end <= ph.start) revert BadPhase();
            _phases.push(ph);
        }
        emit PhasesUpdated();
    }
}
