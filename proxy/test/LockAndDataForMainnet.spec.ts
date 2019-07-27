import { BigNumber } from "bignumber.js";
import * as chaiAsPromised from "chai-as-promised";
import { DepositBoxContract,
  DepositBoxInstance,
  LockAndDataForMainnetContract,
  LockAndDataForMainnetInstance,
  MessageProxyContract,
  MessageProxyInstance,
  } from "../types/truffle-contracts";
import { skipTime } from "./utils/time";

import chai = require("chai");
import { gasMultiplier } from "./utils/command_line";

chai.should();
chai.use((chaiAsPromised as any));

const MessageProxy: MessageProxyContract = artifacts.require("./MessageProxy");
const LockAndDataForMainnet: LockAndDataForMainnetContract = artifacts.require("./LockAndDataForMainnet");
const DepositBox: DepositBoxContract = artifacts.require("./DepositBox");

contract("LockAndDataForMainnet", ([deployer, user, invoker]) => {
  let messageProxy: MessageProxyInstance;
  let lockAndDataForMainnet: LockAndDataForMainnetInstance;
  let depositBox: DepositBoxInstance;

  beforeEach(async () => {
    messageProxy = await MessageProxy.new("Mainnet", {from: deployer, gas: 8000000 * gasMultiplier});
    lockAndDataForMainnet = await LockAndDataForMainnet.new({from: deployer, gas: 8000000 * gasMultiplier});
    depositBox = await DepositBox.new(messageProxy.address, lockAndDataForMainnet.address,
       {from: deployer, gas: 8000000 * gasMultiplier});
  });

  it("should add wei to `lockAndDataForMainnet`", async () => {
    // preparation
    const wei = "10000";
    const lockAndDataBalanceBefore = await web3.eth.getBalance(lockAndDataForMainnet.address);
    // add wei to contract throught `receiveEth` because `receiveEth` have `payable` parameter
    await lockAndDataForMainnet
      .receiveEth(invoker, {value: wei, from: deployer});
    const lockAndDataBalanceAfter = await web3.eth.getBalance(lockAndDataForMainnet.address);
    // expectation
    expect(parseInt(lockAndDataBalanceAfter, 10) -
      parseInt(lockAndDataBalanceBefore, 10)).to.be.equal(parseInt(wei, 10));
  });

  it("should rejected with `Not enough ETH` when invoke sendEth", async () => {
    // preparation
    const wei = "1000";
    const error = "Not enough ETH";
    // add wei to contract throught `receiveEth` because `receiveEth` have `payable` parameter
    // execution
    await lockAndDataForMainnet
      .receiveEth(invoker, {value: wei, from: deployer});
    // execution/expectation
    await lockAndDataForMainnet
      .sendEth(invoker, 10000,
        {from: deployer})
      .should.be.eventually.rejectedWith(error);
  });

  it("should work `sendEth`", async () => {
    // preparation
    const addWeiToContract = "1000";
    const sendWeiFromContract = 100;
    // add wei to contract throught `receiveEth` because `receiveEth` have `payable` parameter
    await lockAndDataForMainnet
      .receiveEth(invoker, {value: addWeiToContract, from: deployer});
    // execution
    await lockAndDataForMainnet
      .sendEth(invoker, sendWeiFromContract,
        {from: deployer});
    const contractBalance = await web3.eth.getBalance(lockAndDataForMainnet.address);
    // expectation
    expect(parseInt(contractBalance, 10))
      .to.equal(parseInt(addWeiToContract, 10) - sendWeiFromContract);
  });

  it("should work `approveTransfer`", async () => {
    // preparation
    const addWeiToContract = "1000";
    const sendWeiFromContract = 100;
    // add wei to contract throught `receiveEth` because `receiveEth` have `payable` parameter
    await lockAndDataForMainnet
      .receiveEth(invoker, {value: addWeiToContract, from: deployer});
    // execution
    await lockAndDataForMainnet
      .approveTransfer(deployer, sendWeiFromContract, {from: deployer});
    // get value from mapping `approveTransfers`
    const bn = new BigNumber(await lockAndDataForMainnet.approveTransfers(deployer));
    // expectation
    parseInt(bn.toString(), 10).should.be.equal(sendWeiFromContract);
  });

  it("should work `getMyEth`", async () => {
    // preparation
    const addWeiToContract = "1000";
    const setWeiToApproveTransfers = 100;
    // add wei to contract throught `receiveEth` because `receiveEth` have `payable` parameter
    await lockAndDataForMainnet
      .receiveEth(invoker, {value: addWeiToContract, from: deployer});
    // without `approveTransfer` `getMyEth` not invoke
    await lockAndDataForMainnet
      .approveTransfer(deployer, setWeiToApproveTransfers, {from: deployer});
    // execution
    await lockAndDataForMainnet
      .getMyEth({from: deployer});
    const contractBalance = await web3.eth.getBalance(lockAndDataForMainnet.address);
    // expectation
    expect(parseInt(contractBalance, 10))
      .to.equal(parseInt(addWeiToContract, 10) - setWeiToApproveTransfers);
  });

  it("should rejected with `User has insufficient ETH` when invoke `getMyEth`", async () => {
    // preparation
    const error = "User has insufficient ETH";
    // execution/expectation
    await lockAndDataForMainnet
      .getMyEth({from: deployer})
      .should.be.eventually.rejectedWith(error);
  });

  it("should rejected with `Not enough ETH` when invoke `getMyEth`", async () => {
    // preparation
    const error = "Not enough ETH";
    const addWeiToContract = "1";
    const setWeiToApproveTransfers = 100;
    // add wei to contract throught `receiveEth` because `receiveEth` have `payable` parameter
    await lockAndDataForMainnet
      .receiveEth(invoker, {value: addWeiToContract, from: deployer});
    // without `approveTransfer` `getMyEth` not invoke
    await lockAndDataForMainnet
      .approveTransfer(deployer, setWeiToApproveTransfers, {from: deployer});
    // execution/expectation
    await lockAndDataForMainnet
      .getMyEth({from: deployer})
      .should.be.eventually.rejectedWith(error);
  });

  it("should invoke setContract without mistakes", async () => {
    await lockAndDataForMainnet
      .setContract("DepositBox", DepositBox.address, {from: deployer});
    const getMapping = await lockAndDataForMainnet.permitted(web3.utils.soliditySha3("DepositBox"));
    // expectation
    expect(getMapping).to.equal(DepositBox.address);
  });

  it("should rejected with `New address is equal zero` when invoke `getMyEth`", async () => {
    const error = "New address is equal zero";
    // execution/expectation
    await lockAndDataForMainnet
      .setContract("DepositBox", "0x0000000000000000000000000000000000000000", {from: deployer})
      .should.be.eventually.rejectedWith(error);
  });

  it("should rejected with `Contract is already added` when invoke `setContract`", async () => {
    // preparation
    const error = "Contract is already added";
    await lockAndDataForMainnet
    .setContract("DepositBox", DepositBox.address, {from: deployer});
    // execution/expectation
    await lockAndDataForMainnet
      .setContract("DepositBox", DepositBox.address, {from: deployer})
      .should.be.eventually.rejectedWith(error);
  });

  it("should rejected with `Given contract address does not contain code` when invoke `setContract`", async () => {
    const error = "Given contract address does not contain code";
    // execution/expectation
    await lockAndDataForMainnet
      .setContract("DepositBox", deployer, {from: deployer})
      .should.be.eventually.rejectedWith(error);
  });

  it("should invoke addSchain without mistakes", async () => {
    const schainName = "someName";
    // execution
    const chain = await lockAndDataForMainnet
      .addSchain(schainName, deployer, {from: deployer});
    const getMapping = await lockAndDataForMainnet.tokenManagerAddresses(web3.utils.soliditySha3(schainName));
    // expectation
    expect(getMapping).to.equal(deployer);
  });

  it("should rejected with `SKALE chain is already set` when invoke `addSchain`", async () => {
    // preparation
    const error = "SKALE chain is already set";
    const schainName = "someName";
    await lockAndDataForMainnet
      .addSchain(schainName, deployer, {from: deployer});
    // execution/expectation
    await lockAndDataForMainnet
      .addSchain(schainName, deployer, {from: deployer})
      .should.be.eventually.rejectedWith(error);
  });

  it("should rejected with `Incorrect Token Manager address` when invoke `addSchain`", async () => {
    // preparation
    const error = "Incorrect Token Manager address";
    const schainName = "someName";
    // execution/expectation
    await lockAndDataForMainnet
      .addSchain(schainName, "0x0000000000000000000000000000000000000000", {from: deployer})
      .should.be.eventually.rejectedWith(error);
  });

});