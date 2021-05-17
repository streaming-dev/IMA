// SPDX-License-Identifier: AGPL-3.0-only

/**
 *   MessageProxyForSchain.sol - SKALE Interchain Messaging Agent
 *   Copyright (C) 2019-Present SKALE Labs
 *   @author Artem Payvin
 *
 *   SKALE IMA is free software: you can redistribute it and/or modify
 *   it under the terms of the GNU Affero General Public License as published
 *   by the Free Software Foundation, either version 3 of the License, or
 *   (at your option) any later version.
 *
 *   SKALE IMA is distributed in the hope that it will be useful,
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *   GNU Affero General Public License for more details.
 *
 *   You should have received a copy of the GNU Affero General Public License
 *   along with SKALE IMA.  If not, see <https://www.gnu.org/licenses/>.
 */

pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./bls/FieldOperations.sol";
import "./bls/SkaleVerifier.sol";
import "./SkaleFeaturesClient.sol";


interface IContractReceiverForSchain {
    function postMessage(
        string calldata schainID,
        address sender,
        bytes calldata data
    )
        external
        returns (bool);
}


contract MessageProxyForSchain is SkaleFeaturesClient {

    using SafeMath for uint;

    /**
     * 16 Agents
     * Synchronize time with time.nist.gov
     * Every agent checks if it is his time slot
     * Time slots are in increments of 10 seconds
     * At the start of his slot each agent:
     * For each connected schain:
     * Read incoming counter on the dst chain
     * Read outgoing counter on the src chain
     * Calculate the difference outgoing - incoming
     * Call postIncomingMessages function passing (un)signed message array
     * ID of this schain, Chain 0 represents ETH mainnet,
     */

    struct OutgoingMessageData {
        string dstChain;
        uint256 msgCounter;
        address srcContract;
        address dstContract;
        bytes data;
    }

    struct ConnectedChainInfo {
        // message counters start with 0
        uint256 incomingMessageCounter;
        uint256 outgoingMessageCounter;
        bool inited;
    }

    struct Message {
        address sender;
        address destinationContract;
        bytes data;
    }

    struct Signature {
        uint256[2] blsSignature;
        uint256 hashA;
        uint256 hashB;
        uint256 counter;
    }

    bytes32 public constant DEBUGGER_ROLE = keccak256("DEBUGGER_ROLE");
    bytes32 public constant CHAIN_CONNECTOR_ROLE = keccak256("CHAIN_CONNECTOR_ROLE");

    mapping(bytes32 => ConnectedChainInfo) public connectedChains;
    //      chainID  =>      message_id  => MessageData
    mapping(bytes32 => mapping(uint256 => bytes32)) private _outgoingMessageDataHash;
    //      chainID  => head of unprocessed messages
    mapping(bytes32 => uint) private _idxHead;
    //      chainID  => tail of unprocessed messages
    mapping(bytes32 => uint) private _idxTail;

    event OutgoingMessage(
        bytes32 indexed dstChainHash,
        uint256 indexed msgCounter,
        address indexed srcContract,
        address dstContract,
        bytes data
    );

    event PostMessageError(
        uint256 indexed msgCounter,
        bytes message
    );

    modifier onlyDebugger() {
        require(hasRole(DEBUGGER_ROLE, msg.sender), "DEBUGGER_ROLE is required");
        _;
    }

    modifier onlyChainConnector() {
        require(hasRole(CHAIN_CONNECTOR_ROLE, msg.sender), "CHAIN_CONNECTOR_ROLE is required");
        _;
    }

    function initialize()
        public
        virtual
        initializer
    {
        AccessControlUpgradeable.__AccessControl_init();
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        connectedChains[
            keccak256(abi.encodePacked("Mainnet"))
        ] = ConnectedChainInfo(
            0,
            0,
            true
        );
    }

    // Registration state detection
    function isConnectedChain(
        string calldata someChainID
    )
        external
        view
        returns (bool)
    {
        if (! connectedChains[keccak256(abi.encodePacked(someChainID))].inited) {
            return false;
        }
        return true;
    }

    /**
     * This is called by  schain owner.
     * On mainnet, SkaleManager will call it every time a SKALE chain is
     * created. Therefore, any SKALE chain is always connected to the main chain.
     * To connect to other chains, the owner needs to explicitly call this function
     */
    function addConnectedChain(
        string calldata newChainID
    )
        external
        onlyChainConnector
    {
        if (keccak256(abi.encodePacked(newChainID)) ==
            keccak256(abi.encodePacked("Mainnet")))
            return;
        require(
            !connectedChains[keccak256(abi.encodePacked(newChainID))].inited,
            "Chain is already connected"
        );
        connectedChains[
            keccak256(abi.encodePacked(newChainID))
        ] = ConnectedChainInfo({
            incomingMessageCounter: 0,
            outgoingMessageCounter: 0,
            inited: true
        });
    }

    function removeConnectedChain(string calldata newChainID) external onlyChainConnector {
        require(
            keccak256(abi.encodePacked(newChainID)) !=
            keccak256(abi.encodePacked("Mainnet")),
            "New chain id can not be equal Mainnet"
        );
        require(
            connectedChains[keccak256(abi.encodePacked(newChainID))].inited,
            "Chain is not initialized"
        );
        delete connectedChains[keccak256(abi.encodePacked(newChainID))];
    }

    // This is called by a smart contract that wants to make a cross-chain call
    function postOutgoingMessage(
        string calldata dstChainID,
        address dstContract,
        bytes calldata data
    )
        external
    {
        bytes32 dstChainHash = keccak256(abi.encodePacked(dstChainID));
        require(connectedChains[dstChainHash].inited, "Destination chain is not initialized");
        connectedChains[dstChainHash].outgoingMessageCounter
            = connectedChains[dstChainHash].outgoingMessageCounter.add(1);
        _pushOutgoingMessageData(
            OutgoingMessageData(
                dstChainID,
                connectedChains[dstChainHash].outgoingMessageCounter - 1,
                msg.sender,
                dstContract,
                data
            )
        );
    }

    function getOutgoingMessagesCounter(string calldata dstChainID)
        external
        view
        returns (uint256)
    {
        bytes32 dstChainHash = keccak256(abi.encodePacked(dstChainID));

        if (!connectedChains[dstChainHash].inited)
            return 0;

        return connectedChains[dstChainHash].outgoingMessageCounter;
    }

    function getIncomingMessagesCounter(string calldata srcChainID)
        external
        view
        returns (uint256)
    {
        bytes32 srcChainHash = keccak256(abi.encodePacked(srcChainID));

        if (!connectedChains[srcChainHash].inited)
            return 0;

        return connectedChains[srcChainHash].incomingMessageCounter;
    }

    function postIncomingMessages(
        string calldata srcChainID,
        uint256 startingCounter,
        Message[] calldata messages,
        Signature calldata signature,
        uint256 idxLastToPopNotIncluding
    )
        external
    {
        bytes32 srcChainHash = keccak256(abi.encodePacked(srcChainID));
        require(_verifyMessages(_hashedArray(messages), signature), "Signature is not verified");
        require(connectedChains[srcChainHash].inited, "Chain is not initialized");
        require(
            startingCounter == connectedChains[srcChainHash].incomingMessageCounter,
            "Starting counter is not qual to incoming message counter");
        for (uint256 i = 0; i < messages.length; i++) {
            _callReceiverContract(srcChainID, messages[i], startingCounter + 1);
        }
        connectedChains[srcChainHash].incomingMessageCounter 
            = connectedChains[srcChainHash].incomingMessageCounter.add(uint256(messages.length));
        _popOutgoingMessageData(srcChainHash, idxLastToPopNotIncluding);
    }

    function moveIncomingCounter(string calldata schainName) external onlyDebugger {
        connectedChains[keccak256(abi.encodePacked(schainName))].incomingMessageCounter =
            connectedChains[keccak256(abi.encodePacked(schainName))].incomingMessageCounter.add(1);
    }

    function setCountersToZero(string calldata schainName) external onlyDebugger {
        connectedChains[keccak256(abi.encodePacked(schainName))].incomingMessageCounter = 0;
        connectedChains[keccak256(abi.encodePacked(schainName))].outgoingMessageCounter = 0;
    }

    function verifyOutgoingMessageData(
        OutgoingMessageData memory message
    )
        public
        view
        returns (bool isValidMessage)
    {
        bytes32 chainId = keccak256(abi.encodePacked(message.dstChain));
        bytes32 messageDataHash = _outgoingMessageDataHash[chainId][message.msgCounter];
        if (messageDataHash == _hashOfMessage(message))
            isValidMessage = true;
    }

    function _callReceiverContract(
        string memory srcChainID,
        Message calldata message,
        uint counter
    )
        private
        returns (bool)
    {
        try IContractReceiverForSchain(message.destinationContract).postMessage(
            srcChainID,
            message.sender,
            message.data
        ) returns (bool success) {
            return success;
        } catch Error(string memory reason) {
            emit PostMessageError(
                counter,
                bytes(reason)
            );
            return false;
        } catch (bytes memory revertData) {
            emit PostMessageError(
                counter,
                revertData
            );
            return false;
        }
    }

    function _hashOfMessage(OutgoingMessageData memory message) private pure returns (bytes32) {
        bytes memory data = abi.encodePacked(
            bytes32(keccak256(abi.encodePacked(message.dstChain))),
            bytes32(message.msgCounter),
            bytes32(bytes20(message.srcContract)),
            bytes32(bytes20(message.dstContract)),
            message.data
        );
        return keccak256(data);
    }

    function _pushOutgoingMessageData(OutgoingMessageData memory d) private {
        bytes32 dstChainHash = keccak256(abi.encodePacked(d.dstChain));
        emit OutgoingMessage(
            dstChainHash,
            d.msgCounter,
            d.srcContract,
            d.dstContract,
            d.data
        );
        _outgoingMessageDataHash[dstChainHash][_idxTail[dstChainHash]] = _hashOfMessage(d);
        _idxTail[dstChainHash] = _idxTail[dstChainHash].add(1);
    }

    /**
     * @dev Pop outgoing message from outgoingMessageData array.
     */
    function _popOutgoingMessageData(
        bytes32 chainId,
        uint256 idxLastToPopNotIncluding
    )
        private
        returns (uint256 cntDeleted)
    {
        cntDeleted = 0;
        uint idxTail = _idxTail[chainId];
        for (uint256 i = _idxHead[chainId]; i < idxLastToPopNotIncluding; ++ i ) {
            if (i >= idxTail)
                break;
            delete _outgoingMessageDataHash[chainId][i];
            ++ cntDeleted;
        }
        if (cntDeleted > 0)
            _idxHead[chainId] = _idxHead[chainId].add(cntDeleted);
    }

    /**
     * @dev Returns hash of message array.
     */
    function _hashedArray(Message[] calldata messages) private pure returns (bytes32) {
        bytes memory data;
        for (uint256 i = 0; i < messages.length; i++) {
            data = abi.encodePacked(
                data,
                bytes32(bytes20(messages[i].sender)),
                bytes32(bytes20(messages[i].destinationContract)),
                messages[i].data
            );
        }
        return keccak256(data);
    }

    /**
     * @dev Converts calldata structure to memory structure and checks
     * whether message BLS signature is valid.
     * Returns true if signature is valid
     */
    function _verifyMessages(
        bytes32 hashedMessages,
        MessageProxyForSchain.Signature calldata signature
    )
        internal
        view
        virtual
        returns (bool)
    {
        return SkaleVerifier.verify(
            Fp2Operations.Fp2Point({
                a: signature.blsSignature[0],
                b: signature.blsSignature[1]
            }),
            hashedMessages,
            signature.counter,
            signature.hashA,
            signature.hashB,
            _getBlsCommonPublicKey()
        );
    }

    function _getBlsCommonPublicKey() private view returns (G2Operations.G2Point memory) {
        SkaleFeatures skaleFeature = getSkaleFeatures();
        return G2Operations.G2Point({
            x: Fp2Operations.Fp2Point({
                a: skaleFeature.getConfigVariableUint256("skaleConfig.nodeInfo.wallets.ima.commonBLSPublicKey0"),
                b: skaleFeature.getConfigVariableUint256("skaleConfig.nodeInfo.wallets.ima.commonBLSPublicKey1")
            }),
            y: Fp2Operations.Fp2Point({
                a: skaleFeature.getConfigVariableUint256("skaleConfig.nodeInfo.wallets.ima.commonBLSPublicKey2"),
                b: skaleFeature.getConfigVariableUint256("skaleConfig.nodeInfo.wallets.ima.commonBLSPublicKey3")
            })
        });
    }
}
