// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FloorFeedStore (from Shuin's ShuinStore)
/// @notice Permanent on-chain file storage. File bytes live in the bytecode of small
/// data contracts (the SSTORE2 pattern: ~200 gas/byte to write, cheap to read), so a
/// token's media can be served straight from the chain with no IPFS or gateway.
/// Files are content-addressed, so storing the same bytes twice costs nothing extra.
/// Deployed once per chain through the CREATE2 deployer; shared by every collection.
contract FloorFeedStore {
    struct File {
        string mime;
        uint64 size;
        address[] chunks;
    }

    /// EIP-170 caps contract code at 24,576 bytes; one byte goes to the STOP prefix.
    uint256 public constant MAX_CHUNK = 24_575;

    mapping(bytes32 => File) private _files;

    event FileStored(bytes32 indexed id, address indexed by, string mime, uint256 size);

    error EmptyFile();
    error ChunkTooLarge(uint256 index, uint256 length);
    error UnknownFile(bytes32 id);
    error WriteFailed();

    /// @notice Content address of a file: hash of its MIME type and each chunk's hash.
    /// (Hashing chunk by chunk avoids copying the whole file into memory.)
    function fileId(string calldata mime, bytes[] calldata chunks) public pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](chunks.length);
        for (uint256 i; i < chunks.length; ++i) {
            hashes[i] = keccak256(chunks[i]);
        }
        return keccak256(abi.encode(mime, hashes));
    }

    /// @notice Store a file split into chunks of at most MAX_CHUNK bytes. Returns its id.
    function store(string calldata mime, bytes[] calldata chunks) external returns (bytes32 id) {
        if (chunks.length == 0) revert EmptyFile();
        id = fileId(mime, chunks);
        if (_files[id].chunks.length != 0) return id;

        File storage f = _files[id];
        f.mime = mime;
        uint256 size;
        for (uint256 i; i < chunks.length; ++i) {
            uint256 len = chunks[i].length;
            if (len == 0 || len > MAX_CHUNK) revert ChunkTooLarge(i, len);
            f.chunks.push(_write(chunks[i]));
            size += len;
        }
        f.size = uint64(size);
        emit FileStored(id, msg.sender, mime, size);
    }

    function exists(bytes32 id) external view returns (bool) {
        return _files[id].chunks.length != 0;
    }

    function info(bytes32 id) external view returns (string memory mime, uint256 size, uint256 chunkCount) {
        File storage f = _get(id);
        return (f.mime, f.size, f.chunks.length);
    }

    function read(bytes32 id) external view returns (bytes memory data) {
        File storage f = _get(id);
        data = new bytes(f.size);
        uint256 offset;
        for (uint256 i; i < f.chunks.length; ++i) {
            address ptr = f.chunks[i];
            uint256 len = ptr.code.length - 1;
            assembly {
                extcodecopy(ptr, add(add(data, 32), offset), 1, len)
            }
            offset += len;
        }
    }

    function _get(bytes32 id) private view returns (File storage f) {
        f = _files[id];
        if (f.chunks.length == 0) revert UnknownFile(id);
    }

    /// Deploys a contract whose runtime code is 0x00 (STOP, so it can never be called) + data.
    function _write(bytes calldata data) private returns (address ptr) {
        bytes memory runtime = bytes.concat(hex"00", data);
        // PUSH4 len, DUP1, PUSH1 0x0e, PUSH1 0, CODECOPY, PUSH1 0, RETURN
        bytes memory creation = bytes.concat(hex"63", bytes4(uint32(runtime.length)), hex"80600e6000396000f3", runtime);
        assembly {
            ptr := create(0, add(creation, 32), mload(creation))
        }
        if (ptr == address(0)) revert WriteFailed();
    }
}
