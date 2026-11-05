import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Interface } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  provider: null,
  ensureChain: vi.fn(),
  readClaimState: vi.fn(),
  sendMintTransaction: vi.fn(),
  waitForMint: vi.fn(),
}));

vi.mock("../../src/wallet.js", async (importOriginal) => ({
  ...await importOriginal(),
  getInjectedProvider: () => mocks.provider,
  ensureChain: mocks.ensureChain,
  readClaimState: mocks.readClaimState,
  sendMintTransaction: mocks.sendMintTransaction,
  waitForMint: mocks.waitForMint,
}));

import App from "../../src/App.jsx";
import { TICKET_ABI } from "../../src/contract.js";

const account = "0x1111111111111111111111111111111111111111";
const other = "0x3333333333333333333333333333333333333333";
const config = {
  address: "0x2222222222222222222222222222222222222222",
  abi: TICKET_ABI,
  network: { chainId: "0xaa36a7", chainName: "Sepolia", rpcUrl: "https://example.test", explorerUrl: "https://sepolia.etherscan.io" },
  error: "",
};
const hash = `0x${"ab".repeat(32)}`;

function provider({ accounts = [account], chainId = config.network.chainId } = {}) {
  const handlers = new Map();
  const state = { accounts, chainId };
  return {
    state,
    request: vi.fn(async ({ method }) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return state.accounts;
      if (method === "eth_chainId") return state.chainId;
      throw new Error(`Unexpected method: ${method}`);
    }),
    on: vi.fn((name, handler) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(handler);
    }),
    removeListener: vi.fn((name, handler) => handlers.get(name)?.delete(handler)),
    emit: (name, value) => handlers.get(name)?.forEach((handler) => handler(value)),
    listenerCount: () => [...handlers.values()].reduce((sum, list) => sum + list.size, 0),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function receipt(minter = account, tokenId = 1n) {
  const iface = new Interface(TICKET_ABI);
  const log = iface.encodeEventLog(iface.getEvent("Mint"), [minter, tokenId]);
  return { status: 1, hash, logs: [{ address: config.address, ...log }] };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.provider = provider();
  mocks.readClaimState.mockResolvedValue({ hasMinted: false, balance: 0n });
  mocks.ensureChain.mockResolvedValue(undefined);
  mocks.sendMintTransaction.mockResolvedValue({ hash });
  mocks.waitForMint.mockResolvedValue(receipt());
});

afterEach(cleanup);

describe("NFT claim interface", () => {
  it("restores an authorized wallet by reading state without requesting approval", async () => {
    render(<App config={config} />);
    await screen.findByText("Eligible to claim");
    expect(screen.getByRole("button", { name: "Claim NFT" }).disabled).toBe(false);
    expect(mocks.readClaimState).toHaveBeenCalledWith(mocks.provider, account, config);
    expect(mocks.provider.request.mock.calls.map(([request]) => request.method)).not.toContain("eth_requestAccounts");
    expect(mocks.ensureChain).not.toHaveBeenCalled();
  });

  it("disables another claim based on the on-chain record even with no current NFT balance", async () => {
    mocks.readClaimState.mockResolvedValue({ hasMinted: true, balance: 0n });
    render(<App config={config} />);
    await screen.findByText("Already claimed");
    const button = screen.getByRole("button", { name: "NFT already claimed" });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.sendMintTransaction).not.toHaveBeenCalled();
  });

  it("blocks claims on the wrong chain and reads eligibility after an explicit switch", async () => {
    mocks.provider.state.chainId = "0x1";
    mocks.ensureChain.mockImplementation(async () => {
      mocks.provider.state.chainId = config.network.chainId;
      mocks.provider.emit("chainChanged", config.network.chainId);
    });
    render(<App config={config} />);
    await screen.findByText("Wrong network (chain 1)");
    expect(screen.getByRole("button", { name: "Claim NFT" }).disabled).toBe(true);
    expect(mocks.readClaimState).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Switch to Sepolia" }));
    await screen.findByText("Eligible to claim");
    await waitFor(() => expect(screen.getByRole("button", { name: "Claim NFT" }).disabled).toBe(false));
    expect(mocks.ensureChain).toHaveBeenCalledWith(mocks.provider, config.network);
  });

  it("shows rejected connection requests and lets the user try again", async () => {
    mocks.provider.state.accounts = [];
    const original = mocks.provider.request.getMockImplementation();
    mocks.provider.request.mockImplementation(async (request) => {
      if (request.method === "eth_requestAccounts") throw { code: 4001 };
      return original(request);
    });
    render(<App config={config} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect MetaMask" }));
    await screen.findByText("Request rejected in the wallet. You can try again when ready.");
    expect(screen.getByRole("button", { name: "Connect MetaMask" }).disabled).toBe(false);
    expect(mocks.sendMintTransaction).not.toHaveBeenCalled();
  });

  it("shows pending transaction details then uses the receipt and fresh state for success", async () => {
    const confirmation = deferred();
    mocks.waitForMint.mockReturnValue(confirmation.promise);
    render(<App config={config} />);
    await screen.findByText("Eligible to claim");
    fireEvent.click(screen.getByRole("button", { name: "Claim NFT" }));
    await screen.findByText("Transaction submitted. Waiting for a block confirmation...");
    expect(screen.getByRole("button", { name: "Processing claim..." }).disabled).toBe(true);
    expect(screen.getByRole("link", { name: "View transaction on Etherscan" }).href).toBe(`${config.network.explorerUrl}/tx/${hash}`);
    mocks.readClaimState.mockResolvedValue({ hasMinted: true, balance: 1n });
    await act(async () => { confirmation.resolve(receipt(account, 7n)); });
    await screen.findByText("NFT #7 claimed successfully.");
    await screen.findByText("Already claimed");
    expect(screen.getByRole("button", { name: "NFT already claimed" }).disabled).toBe(true);
    expect(screen.getByText("7", { selector: "strong" })).toBeTruthy();
    expect(mocks.sendMintTransaction).toHaveBeenCalledExactlyOnceWith(mocks.provider, account, config);
  });

  it("keeps a rejected claim eligible and allows another attempt", async () => {
    mocks.sendMintTransaction.mockRejectedValue({ code: "ACTION_REJECTED" });
    render(<App config={config} />);
    await screen.findByText("Eligible to claim");
    fireEvent.click(screen.getByRole("button", { name: "Claim NFT" }));
    await screen.findByText("Request rejected in the wallet. You can try again when ready.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Claim NFT" }).disabled).toBe(false));
    expect(mocks.waitForMint).not.toHaveBeenCalled();
  });

  it("does not apply an old account's late receipt to the new account", async () => {
    const confirmation = deferred();
    mocks.waitForMint.mockReturnValue(confirmation.promise);
    render(<App config={config} />);
    await screen.findByText("Eligible to claim");
    fireEvent.click(screen.getByRole("button", { name: "Claim NFT" }));
    await screen.findByText(hash);
    act(() => {
      mocks.provider.state.accounts = [other];
      mocks.provider.emit("accountsChanged", [other]);
    });
    await screen.findByText(other);
    await screen.findByText("Eligible to claim");
    await act(async () => { confirmation.resolve(receipt()); });
    expect(screen.queryByText(/claimed successfully/)).toBeNull();
    expect(screen.queryByText(hash)).toBeNull();
    expect(screen.getByRole("button", { name: "Claim NFT" }).disabled).toBe(false);
  });

  it("cleans up all wallet event listeners under React StrictMode", async () => {
    const view = render(<StrictMode><App config={config} /></StrictMode>);
    await screen.findByText("Eligible to claim");
    expect(mocks.provider.listenerCount()).toBe(4);
    view.unmount();
    expect(mocks.provider.listenerCount()).toBe(0);
  });
});
