// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @license
 * SKALE IMA
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * @file 1_migration_to_mainnet.js
 * @copyright SKALE Labs 2019-Present
 */

const fs = require( "fs" );
const fsPromises = fs.promises;

const Web3 = require( "web3" );

const jsonData = require( "../data/skaleManagerComponents.json" );
const configFile = require( "../truffle-config.js" );

const { scripts, ConfigManager } = require( "@openzeppelin/cli" );
const { add, push, create } = scripts;

async function deploy( deployer, networkName, accounts ) {

    const deployAccount = accounts[0];
    const options = await ConfigManager.initNetworkConfiguration( { network: networkName, from: deployAccount } );

    const contracts = [
        "MessageProxyForMainnet",
        "Linker",
        "DepositBoxEth",
        "DepositBoxERC20",
        "DepositBoxERC721",
        "CommunityPool"
    ];

    contractsData = [];
    for( const contract of contracts )
        contractsData.push( { name: contract, alias: contract } );

    add( { contractsData: contractsData } );

    await push( options );

    if( jsonData.contract_manager_address !== null && jsonData.contract_manager_address !== "" && jsonData.contract_manager_address !== "0x0000000000000000000000000000000000000000" ) {
        if( configFile.networks[networkName].host !== "" && configFile.networks[networkName].host !== undefined && configFile.networks[networkName].port !== "" && configFile.networks[networkName].port !== undefined ) {
            const web3 = new Web3( new Web3.providers.HttpProvider( "http://" + configFile.networks[networkName].host + ":" + configFile.networks[networkName].port ) );
            if( await web3.eth.getCode( jsonData.contract_manager_address ) === "0x" ) {
                if( networkName !== "test" && networkName !== "coverage" ) {
                    console.log( "Please provide a correct contract manager address of skale-manager with a code" );
                    process.exit( 0 );
                } else
                    console.log( "WARNING: contract manager address does not contain code" );

            }
        } else if( configFile.networks[networkName].provider !== "" && configFile.networks[networkName].provider !== undefined ) {
            const web3 = new Web3( configFile.networks[networkName].provider() );
            if( await web3.eth.getCode( jsonData.contract_manager_address ) === "0x" ) {
                if( networkName !== "test" && networkName !== "coverage" ) {
                    console.log( "Please provide a correct contract manager address of skale-manager with a code" );
                    process.exit( 0 );
                } else
                    console.log( "WARNING: contract manager address does not contain code" );

            }
        } else {
            console.log( "Unknown type of provider" );
            process.exit( 0 );
        }
    } else {
        console.log( "Please provide a contract manager address of skale-manager" );
        process.exit( 0 );
    }

    const deployed = new Map();
    let linker;
    let messageProxy;
    for( const contractName of contracts ) {
        let contract;
        if( contractName == "MessageProxyForMainnet" ) {
            contract = await create( Object.assign( { contractAlias: contractName, methodName: "initialize", methodArgs: [ jsonData.contract_manager_address ] }, options ) );
            messageProxy = contract;
            console.log( "MessageProxyForMainnet address:", contract.address );
        } else if( contractName == "Linker" ) {
            contract = await create( Object.assign( { contractAlias: contractName, methodName: "initialize", methodArgs: [ deployed.get( "MessageProxyForMainnet" ).address ] }, options ) );
            linker = contract;
            console.log( "Linker address:", contract.address );
        } else { // Mainnet Contracts
            contract = await create(
                Object.assign(
                    {
                        contractAlias: contractName,
                        methodName: "initialize",
                        methodArgs: [
                            jsonData.contract_manager_address,
                            deployed.get( "Linker" ).address,
                            deployed.get( "MessageProxyForMainnet" ).address,
                        ]
                    },
                    options
                )
            );
            console.log( contractName, "address:", contract.address );
            await linker.methods.registerMainnetContract( contract.address ).send( { from: deployAccount } ).then( function( res ) {
                console.log( "Contract", contractName, "with address", contract.address, "is registered as Mainnet Contract in Linker" );
            } );
            if (contractName == "CommunityPool") {
                await messageProxy.methods.setCommunityPool(contract.address).send({from: deployAccount});
            }
        }

        deployed.set( contractName, contract );
    }

    console.log( "Deploy done, writing results..." );

    const jsonObject = { };
    for( const contractName of contracts ) {
        if( contractName !== "MessageProxyForMainnet" )
            propertyName = contractName.replace( /([a-z0-9])(?=[A-Z])/g, "$1_" ).toLowerCase();
        else
            propertyName = "message_proxy_mainnet";

        jsonObject[propertyName + "_address"] = deployed.get( contractName ).address;
        jsonObject[propertyName + "_abi"] = artifacts.require( "./" + contractName ).abi;
    }

    await fsPromises.writeFile( "data/proxyMainnet.json", JSON.stringify( jsonObject ) );
    console.log( "Done, check proxyMainnet.json file in data folder." );

    console.log( "Writing done, register contract manager and message proxy..." );

    if( jsonData.contract_manager_address !== null && jsonData.contract_manager_address !== "" && jsonData.contract_manager_address !== "0x0000000000000000000000000000000000000000" ) {
        // register MessageProxy in ContractManager
        if( jsonData.contract_manager_abi !== "" && jsonData.contract_manager_abi !== undefined ) {
            if( configFile.networks[networkName].host !== "" && configFile.networks[networkName].host !== undefined && configFile.networks[networkName].port !== "" && configFile.networks[networkName].port !== undefined ) {
                const web3 = new Web3( new Web3.providers.HttpProvider( "http://" + configFile.networks[networkName].host + ":" + configFile.networks[networkName].port ) );
                if( await web3.eth.getCode( jsonData.contract_manager_address ) !== "0x" ) {
                    const contractManager = new web3.eth.Contract( jsonData.contract_manager_abi, jsonData.contract_manager_address );
                    const methodRegister = await contractManager.methods.setContractsAddress( "MessageProxyForMainnet", deployed.get( "MessageProxyForMainnet" ).address ).encodeABI();
                    const ownerAddress = await contractManager.methods.owner().call();
                    if( await web3.utils.toChecksumAddress( ownerAddress ) !== await web3.utils.toChecksumAddress( deployAccount ) )
                        console.log( "Owner of ContractManager is not the same of the deployer" );
                    else {
                        try {
                            await web3.eth.sendTransaction( { from: deployAccount, to: jsonData.contract_manager_address, data: methodRegister } );
                            console.log( "Successfully registered MessageProxy in ContractManager" );
                        } catch ( error ) {
                            console.log( "Registration of MessageProxy is failed on ContractManager. Please redo it by yourself!\nError:", error );
                        }
                    }
                } else
                    console.log( "Contract Manager address is not a contract" );

            } else if( configFile.networks[networkName].provider !== "" && configFile.networks[networkName].provider !== undefined ) {
                const web3 = new Web3( configFile.networks[networkName].provider() );
                if( await web3.eth.getCode( jsonData.contract_manager_address ) !== "0x" ) {
                    const contractManager = new web3.eth.Contract( jsonData.contract_manager_abi, jsonData.contract_manager_address );
                    const methodRegister = await contractManager.methods.setContractsAddress( "MessageProxyForMainnet", deployed.get( "MessageProxyForMainnet" ).address ).encodeABI();
                    const ownerAddress = await contractManager.methods.owner().call();
                    if( await web3.utils.toChecksumAddress( ownerAddress ) !== await web3.utils.toChecksumAddress( deployAccount ) )
                        console.log( "Owner of ContractManager is not the same of the deployer" );
                    else {
                        try {
                            const nonceNumber = await web3.eth.getTransactionCount( deployAccount );
                            const tx = {
                                nonce: nonceNumber,
                                from: deployAccount,
                                to: jsonData.contract_manager_address,
                                gas: "150000",
                                data: methodRegister
                            };
                            const privateKey = process.env.PRIVATE_KEY_FOR_ETHEREUM;
                            const signedTx = await web3.eth.signTransaction( tx, "0x" + privateKey );
                            await web3.eth.sendSignedTransaction( signedTx.raw || signedTx.rawTransaction );
                            console.log( "Successfully registered MessageProxy in ContractManager" );
                        } catch ( error ) {
                            console.log( "Registration of MessageProxy is failed on ContractManager. Please redo it by yourself!\nError:", error );
                        }
                    }
                } else
                    console.log( "Contract Manager address is not a contract" );

            } else
                console.log( "Unknown type of network" );

        } else
            console.log( "Please provide an abi of ContractManager" );

    }

    console.log( "Registration is completed!" );
}

module.exports = deploy;
