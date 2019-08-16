pragma solidity ^0.5.0;

import "./Permissions.sol";
import "openzeppelin-solidity/contracts/token/ERC721/IERC721Full.sol";

interface ITokenFactoryForERC721 {
    function createERC721(bytes calldata data)
        external
        returns (address payable);
}

interface ILockAndDataERC721S {
    function ERC721Tokens(uint index) external returns (address);
    function ERC721Mapper(address contractERC721) external returns (uint);
    function addERC721Token(address contractERC721, uint contractPosition) external;
    function sendERC721(address contractHere, address to, uint tokenId) external returns (bool);
    function receiveERC721(address contractHere, uint tokenId) external returns (bool);
}

contract ERC721ModuleForSchain is Permissions {

    event ERC721TokenCreated(uint indexed contractPosition, address tokenAddress);
    event EncodedData(bytes data);
    event EncodedRawData(bytes data);
    event Data(address contractAddress);

    constructor(address newLockAndDataAddress) Permissions(newLockAndDataAddress) public {

    }

    function receiveERC721(address contractHere, address to, uint tokenId, bool isRAW) public allow("TokenManager") returns (bytes memory data) {
        address lockAndDataERC721 = ContractManager(lockAndDataAddress).permitted(keccak256(abi.encodePacked("LockAndDataERC721")));
        if (!isRAW) {
            uint contractPosition = ILockAndDataERC721S(lockAndDataERC721).ERC721Mapper(contractHere);
            require(contractPosition > 0, "Not existing ERC-721 contract");
            require(ILockAndDataERC721S(lockAndDataERC721).receiveERC721(contractHere, tokenId), "Cound not receive ERC721 Token");
            data = encodeData(contractHere, contractPosition, to, tokenId);
            emit EncodedData(bytes(data));
            return data;
        } else {
            data = encodeRawData(to, tokenId);
            emit EncodedRawData(bytes(data));
            return data;
        }
    }

    function sendERC721(address to, bytes memory data) public allow("TokenManager") returns (bool) {
        address lockAndDataERC721 = ContractManager(lockAndDataAddress).permitted(keccak256(abi.encodePacked("LockAndDataERC721")));
        uint contractPosition;
        address contractAddress;
        address receiver;
        uint tokenId;
        if (to == address(0)) {
            (contractPosition, receiver, tokenId) = fallbackDataParser(data);
            contractAddress = ILockAndDataERC721S(lockAndDataERC721).ERC721Tokens(contractPosition);
            if (contractAddress == address(0)) {
                address tokenFactoryAddress = ContractManager(lockAndDataAddress).permitted(keccak256(abi.encodePacked("TokenFactory")));
                contractAddress = ITokenFactoryForERC721(tokenFactoryAddress).createERC721(data);
                emit ERC721TokenCreated(contractPosition, contractAddress);
                ILockAndDataERC721S(lockAndDataERC721).addERC721Token(contractAddress, contractPosition);
            }
        } else {
            (receiver, tokenId) = fallbackRawDataParser(data);
            contractAddress = to;
        }
        emit Data(contractAddress);
        return ILockAndDataERC721S(lockAndDataERC721).sendERC721(contractAddress, receiver, tokenId);
    }

    function getReceiver(address to, bytes memory data) public pure returns (address receiver) {
        uint contractPosition;
        uint tokenId;
        if (to == address(0)) {
            (contractPosition, receiver, tokenId) = fallbackDataParser(data);
        } else {
            (receiver, tokenId) = fallbackRawDataParser(data);
        }
    }

    function encodeData(address contractHere, uint contractPosition, address to, uint tokenId) internal view returns (bytes memory data) {
        string memory name = IERC721Full(contractHere).name();
        string memory symbol = IERC721Full(contractHere).symbol();
        data = abi.encodePacked(
            bytes1(uint8(5)),
            bytes32(contractPosition),
            bytes32(bytes20(to)),
            bytes32(tokenId),
            bytes(name).length,
            name,
            bytes(symbol).length,
            symbol
        );
    }

    function encodeRawData(address to, uint tokenId) internal pure returns (bytes memory data) {
        data = abi.encodePacked(
            bytes1(uint8(21)),
            bytes32(bytes20(to)),
            bytes32(tokenId)
        );
    }

    function fallbackDataParser(bytes memory data)
        internal
        pure
        returns (uint, address payable, uint)
    {
        bytes32 contractIndex;
        bytes32 to;
        bytes32 token;
        assembly {
            contractIndex := mload(add(data, 33))
            to := mload(add(data, 65))
            token := mload(add(data, 97))
        }
        return (
            uint(contractIndex), address(bytes20(to)), uint(token)
        );
    }

    function fallbackRawDataParser(bytes memory data)
        internal
        pure
        returns (address payable, uint)
    {
        bytes32 to;
        bytes32 token;
        assembly {
            to := mload(add(data, 33))
            token := mload(add(data, 65))
        }
        return (address(bytes20(to)), uint(token));
    }
}