import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { BrowserProvider, ContractFactory, ZeroAddress } from "ethers";
import { compileContracts } from "../../scripts/compile-contract.mjs";

let connection;
let provider;
let artifacts;
let alice;
let bob;

before(async () => {
  artifacts = await compileContracts({ includeFixtures: true, writeArtifacts: false });
  connection = await network.create("hardhatMainnet");
  provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  alice = await provider.getSigner(0);
  bob = await provider.getSigner(1);
});

after(async () => {
  provider?.destroy();
  await connection?.close();
});

async function deploy(name = "TicketNFT") {
  const artifact = artifacts[name];
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, alice).deploy();
  await contract.waitForDeployment();
  return contract;
}

test("two wallets claim unique ERC-721 tickets and emit the matching events", async () => {
  const ticket = await deploy();
  const aliceAddress = await alice.getAddress();
  const bobAddress = await bob.getAddress();
  assert.equal(await ticket.name(), "Ticket NFT");
  assert.equal(await ticket.symbol(), "TICKET");
  assert.equal(await ticket.supportsInterface("0x80ac58cd"), true);
  assert.equal(await ticket.hasMinted(aliceAddress), false);
  const receipt = await (await ticket.mint()).wait();
  const logs = receipt.logs.map((entry) => ticket.interface.parseLog(entry));
  const minted = logs.find((entry) => entry?.name === "Mint");
  const transferred = logs.find((entry) => entry?.name === "Transfer");
  assert.equal(minted.args.minter, aliceAddress);
  assert.equal(minted.args.tokenId, 1n);
  assert.equal(transferred.args.from, ZeroAddress);
  assert.equal(transferred.args.to, aliceAddress);
  await (await ticket.connect(bob).mint()).wait();
  assert.equal(await ticket.ownerOf(1), aliceAddress);
  assert.equal(await ticket.ownerOf(2), bobAddress);
  assert.equal(await ticket.hasMinted(aliceAddress), true);
  assert.equal(await ticket.hasMinted(bobAddress), true);
});

test("duplicate claims fail at the contract and cannot consume a token ID", async () => {
  const ticket = await deploy();
  await (await ticket.mint()).wait();
  await assert.rejects(ticket.mint({ gasLimit: 300000 }), /One ticket per wallet/);
  await (await ticket.connect(bob).mint()).wait();
  assert.equal(await ticket.ownerOf(2), await bob.getAddress());
  assert.equal(await ticket.balanceOf(await alice.getAddress()), 1n);
});

test("transferring a ticket does not restore claim eligibility", async () => {
  const ticket = await deploy();
  const aliceAddress = await alice.getAddress();
  const bobAddress = await bob.getAddress();
  await (await ticket.mint()).wait();
  await (await ticket.transferFrom(aliceAddress, bobAddress, 1)).wait();
  assert.equal(await ticket.balanceOf(aliceAddress), 0n);
  assert.equal(await ticket.hasMinted(aliceAddress), true);
  await assert.rejects(ticket.mint({ gasLimit: 300000 }), /One ticket per wallet/);
  // Receiving someone else's NFT is not the same as using one's own claim.
  assert.equal(await ticket.hasMinted(bobAddress), false);
  await (await ticket.connect(bob).mint()).wait();
  assert.equal(await ticket.balanceOf(bobAddress), 2n);
});

test("a rejected receiver callback rolls back the claim and token counter", async () => {
  const ticket = await deploy();
  const receiver = await deploy("ToggleReceiver");
  const receiverAddress = await receiver.getAddress();
  await assert.rejects(receiver.claim(await ticket.getAddress(), { gasLimit: 500000 }), /Receiver rejected/);
  assert.equal(await ticket.hasMinted(receiverAddress), false);
  assert.equal(await ticket.balanceOf(receiverAddress), 0n);
  await (await receiver.setAccepts(true)).wait();
  await (await receiver.claim(await ticket.getAddress())).wait();
  assert.equal(await ticket.ownerOf(1), receiverAddress);
  assert.equal(await ticket.hasMinted(receiverAddress), true);
});

test("a receiver cannot reenter mint to claim a second ticket", async () => {
  const ticket = await deploy();
  const receiver = await deploy("ReentrantReceiver");
  await (await receiver.claim(await ticket.getAddress())).wait();
  assert.equal(await receiver.secondClaimRejected(), true);
  assert.equal(await ticket.balanceOf(await receiver.getAddress()), 1n);
  await (await ticket.connect(bob).mint()).wait();
  assert.equal(await ticket.ownerOf(2), await bob.getAddress());
});
