import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { JsonRpcProvider, ContractFactory } from "ethers";
import { compileContracts, projectRoot } from "./compile-contract.mjs";

// Deliberately fixed to loopback: this script never deploys to a public network
// and never reads a private key. Sepolia deployment is performed in Remix.
const rpcUrl = "http://127.0.0.1:8545";
const provider = new JsonRpcProvider(rpcUrl);
try {
  const network = await provider.getNetwork();
  if (network.chainId !== 31337n) throw new Error("Local deployment requires chain ID 31337.");
  const version = await provider.send("web3_clientVersion", []);
  if (!version.toLowerCase().includes("hardhat")) throw new Error("Local deployment requires the Hardhat development node.");
  const { TicketNFT } = await compileContracts();
  const signer = await provider.getSigner(0);
  const ticket = await new ContractFactory(TicketNFT.abi, TicketNFT.bytecode, signer).deploy();
  await ticket.waitForDeployment();
  const address = await ticket.getAddress();
  const deployment = { chainId: 31337, rpcUrl, address, transactionHash: ticket.deploymentTransaction().hash };
  await mkdir(resolve(projectRoot, "deployments"), { recursive: true });
  await writeFile(resolve(projectRoot, "deployments/localhost.json"), JSON.stringify(deployment, null, 2) + "\n");
  console.log(`Local TicketNFT: ${address}`);
  console.log("Set these public values in .env.local, then restart Vite:");
  console.log(`VITE_CHAIN_ID=31337\nVITE_CONTRACT_ADDRESS=${address}`);
} finally {
  provider.destroy();
}
