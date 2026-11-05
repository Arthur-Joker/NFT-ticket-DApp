import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ContractFactory, JsonRpcProvider, getAddress } from "ethers";
import { chromium } from "playwright";
import { compileContracts, projectRoot } from "./compile-contract.mjs";

// Real browser + real local EVM, with an explicitly simulated wallet approval
// bridge. No extension, private key, Sepolia RPC or public-chain transaction.
const rpc = new JsonRpcProvider("http://127.0.0.1:8545");
let server;
let browser;
try {
  assert.equal((await rpc.getNetwork()).chainId, 31337n, "Start the local chain with npm run chain.");
  assert.match(await rpc.send("web3_clientVersion", []), /hardhat/i);
  const accounts = (await rpc.send("eth_accounts", [])).map(getAddress);
  const { TicketNFT } = await compileContracts();
  const ticket = await new ContractFactory(TicketNFT.abi, TicketNFT.bytecode, await rpc.getSigner(0)).deploy();
  await ticket.waitForDeployment();
  const address = await ticket.getAddress();
  process.env.VITE_CONTRACT_ADDRESS = address;
  process.env.VITE_CHAIN_ID = "31337";
  const { createServer } = await import("vite");
  server = await createServer({ server: { host: "127.0.0.1", port: 5174, strictPort: true } });
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const context = await browser.newContext();
  // Calls reach only this explicitly checked, loopback Hardhat provider.
  await context.exposeBinding("__localTestRpc", async (_, request) => rpc.send(request.method, request.params ?? []));
  await context.addInitScript(({ accounts }) => {
    const listeners = new Map();
    let index = Number(sessionStorage.getItem("test-wallet-index") ?? 0);
    let authorized = sessionStorage.getItem("test-wallet-authorized") === "yes";
    let chainId = "0x7a69";
    function emit(name, data) { for (const fn of listeners.get(name) ?? []) fn(data); }
    window.__selectTestAccount = (next) => {
      index = next;
      sessionStorage.setItem("test-wallet-index", String(index));
      emit("accountsChanged", [accounts[index]]);
    };
    window.__setTestChain = (next) => { chainId = next; emit("chainChanged", next); };
    window.__walletApprovalRequests = 0;
    window.ethereum = {
      isMetaMask: true,
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(fn);
      },
      removeListener(name, fn) { listeners.get(name)?.delete(fn); },
      async request({ method, params = [] }) {
        if (method === "eth_requestAccounts") {
          ++window.__walletApprovalRequests;
          authorized = true;
          sessionStorage.setItem("test-wallet-authorized", "yes");
          return [accounts[index]];
        }
        if (method === "eth_accounts") return authorized ? [accounts[index]] : [];
        if (method === "eth_chainId") return chainId;
        if (method === "wallet_switchEthereumChain") {
          if (params[0].chainId !== "0x7a69") throw new Error("This test only supports the local chain.");
          window.__setTestChain("0x7a69");
          return null;
        }
        if (method === "eth_sendTransaction" && params[0].from.toLowerCase() !== accounts[index].toLowerCase()) {
          throw new Error("Wrong test account.");
        }
        return window.__localTestRpc({ method, params });
      },
    };
  }, { accounts: accounts.slice(0, 2) });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:5174");
  await page.getByRole("button", { name: "Connect MetaMask", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__walletApprovalRequests), 0);
  await page.getByRole("button", { name: "Connect MetaMask", exact: true }).click();
  await page.getByText("Eligible to claim", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Claim NFT", exact: true }).click();
  await page.getByText("NFT #1 claimed successfully.", { exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await ticket.ownerOf(1n), accounts[0]);
  assert.equal(await ticket.hasMinted(accounts[0]), true);
  assert.equal(await page.getByRole("button", { name: "NFT already claimed", exact: true }).isDisabled(), true);

  await page.reload();
  await page.getByText("Already claimed", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__walletApprovalRequests), 0, "Reload should not prompt for account access.");
  await page.evaluate(() => window.__selectTestAccount(1));
  await page.getByText("Eligible to claim", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Claim NFT", exact: true }).click();
  await page.getByText("NFT #2 claimed successfully.", { exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await ticket.ownerOf(2n), accounts[1]);

  await page.evaluate(() => window.__setTestChain("0x1"));
  await page.getByRole("button", { name: "Switch to Local Hardhat", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Claim NFT", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Switch to Local Hardhat", exact: true }).click();
  await page.getByText("Already claimed", { exact: true }).waitFor();
  assert.deepEqual(errors, [], "The browser should not report an unhandled page error.");
  const report = {
    network: "local Hardhat, chain31337", wallet: "simulated EIP-1193 approval bridge; not a MetaMask extension test",
    address, passed: ["no automatic wallet prompt", "wallet A mint + on-chain ownership", "reload restores claim", "wallet B mint", "wrong-network blocking and recovery"],
    pageErrors: errors,
  };
  await mkdir(resolve(projectRoot, "artifacts"), { recursive: true });
  await writeFile(resolve(projectRoot, "artifacts/browser-smoke.json"), JSON.stringify(report, null, 2) + "\n");
  await page.screenshot({ path: resolve(projectRoot, "artifacts/browser-smoke.png"), fullPage: true });
  console.log("Browser/local-EVM smoke passed: two wallets minted, reload restored state, wrong network blocked and recovered.");
  console.log("Report: artifacts/browser-smoke.json (wallet approvals simulated; MetaMask/Sepolia still require manual verification).");
} finally {
  await browser?.close();
  await server?.close();
  rpc.destroy();
}
