import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCode: vi.fn(), getSigner: vi.fn(), destroy: vi.fn(),
  hasMinted: vi.fn(), balanceOf: vi.fn(), mint: vi.fn(),
}));

vi.mock("ethers", async (importOriginal) => {
  const ethers = await importOriginal();
  return {
    ...ethers,
    BrowserProvider: class {
      getCode = mocks.getCode;
      getSigner = mocks.getSigner;
      destroy = mocks.destroy;
    },
    Contract: class {
      hasMinted = mocks.hasMinted;
      balanceOf = mocks.balanceOf;
      mint = mocks.mint;
    },
  };
});

import { ensureChain, formatWalletError, getInjectedProvider, readClaimState, sendMintTransaction, waitForMint } from "../../src/wallet.js";

const account = "0x1111111111111111111111111111111111111111";
const address = "0x2222222222222222222222222222222222222222";
const other = "0x3333333333333333333333333333333333333333";
const network = { chainId: "0xaa36a7", chainName: "Sepolia", rpcUrl: "https://example.test", explorerUrl: "https://sepolia.etherscan.io" };
const config = { address, network, abi: [] };

function wallet({ chainId = network.chainId, accounts = [account] } = {}) {
  return { request: vi.fn(async ({ method, params }) => {
    if (method === "eth_chainId") return chainId;
    if (method === "eth_accounts") return accounts;
    if (method === "wallet_switchEthereumChain") { chainId = params[0].chainId; return null; }
    throw new Error(`Unexpected method: ${method}`);
  }) };
}

function transaction(overrides = {}) {
  return { to: address, from: account, data: "0x1249c58b", value: 0n, wait: vi.fn().mockResolvedValue({ status: 1, hash: "0xreceipt" }), ...overrides };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  mocks.getCode.mockResolvedValue("0x6000");
  mocks.getSigner.mockResolvedValue({});
  mocks.hasMinted.mockResolvedValue(false);
  mocks.balanceOf.mockResolvedValue(0n);
  mocks.mint.mockResolvedValue(transaction());
});

describe("wallet networks", () => {
  it("selects the MetaMask provider when multiple extensions are injected", () => {
    const metamask = { isMetaMask: true };
    vi.stubGlobal("window", { ethereum: { providers: [{ isOtherWallet: true }, metamask] } });
    expect(getInjectedProvider()).toBe(metamask);
  });

  it("does not prompt when already on the configured chain", async () => {
    const ethereum = wallet();
    await ensureChain(ethereum, network);
    expect(ethereum.request).toHaveBeenCalledExactlyOnceWith({ method: "eth_chainId" });
  });

  it("adds an unknown chain and then explicitly selects it", async () => {
    let chainId = "0x1";
    let switchCount = 0;
    const ethereum = { request: vi.fn(async ({ method, params }) => {
      if (method === "eth_chainId") return chainId;
      if (method === "wallet_addEthereumChain") return null;
      if (method === "wallet_switchEthereumChain") {
        if (++switchCount === 1) throw { code: 4902 };
        chainId = params[0].chainId;
        return null;
      }
    }) };
    await ensureChain(ethereum, network);
    expect(ethereum.request).toHaveBeenCalledWith({ method: "wallet_addEthereumChain", params: [expect.objectContaining({ chainId: network.chainId, rpcUrls: [network.rpcUrl] })] });
    expect(switchCount).toBe(2);
  });

  it("preserves a rejected switch instead of trying to add another network", async () => {
    const ethereum = { request: vi.fn().mockResolvedValueOnce("0x1").mockRejectedValueOnce({ code: 4001 }) };
    await expect(ensureChain(ethereum, network)).rejects.toMatchObject({ code: 4001 });
    expect(ethereum.request).toHaveBeenCalledTimes(2);
  });
});

describe("reads and mint submission", () => {
  it("queries claim history separately from the current NFT balance without a wallet prompt", async () => {
    const ethereum = wallet();
    mocks.hasMinted.mockResolvedValue(true);
    expect(await readClaimState(ethereum, account, config)).toEqual({ hasMinted: true, balance: 0n });
    expect(ethereum.request.mock.calls.every(([request]) => request.method === "eth_chainId")).toBe(true);
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("refuses reads on the wrong chain without prompting or touching a contract", async () => {
    await expect(readClaimState(wallet({ chainId: "0x1" }), account, config)).rejects.toMatchObject({ code: "WRONG_CHAIN" });
    expect(mocks.getCode).not.toHaveBeenCalled();
  });

  it("rejects a wallet address pasted in place of a deployed contract", async () => {
    mocks.getCode.mockResolvedValue("0x");
    await expect(readClaimState(wallet(), account, config)).rejects.toMatchObject({ code: "NO_CONTRACT" });
    expect(mocks.hasMinted).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("discards reads whose chain changed while they were in flight", async () => {
    const ethereum = { request: vi.fn().mockResolvedValueOnce(network.chainId).mockResolvedValueOnce("0x1") };
    await expect(readClaimState(ethereum, account, config)).rejects.toMatchObject({ code: "WRONG_CHAIN" });
  });

  it("prevents claiming from an account that changed since the UI was rendered", async () => {
    await expect(sendMintTransaction(wallet({ accounts: [other] }), account, config)).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(mocks.getSigner).not.toHaveBeenCalled();
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("does not send another mint after the ticket was transferred away", async () => {
    mocks.hasMinted.mockResolvedValue(true);
    await expect(sendMintTransaction(wallet(), account, config)).rejects.toMatchObject({ code: "ALREADY_CLAIMED" });
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("checks the selected account again after preflight reads", async () => {
    let reads = 0;
    const ethereum = { request: vi.fn(async ({ method }) => method === "eth_chainId" ? network.chainId : (++reads === 1 ? [account] : [other])) };
    await expect(sendMintTransaction(ethereum, account, config)).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("binds the mint to the selected chain and holds the provider until confirmation", async () => {
    const sent = await sendMintTransaction(wallet(), account, config);
    expect(mocks.mint).toHaveBeenCalledWith({ chainId: 11155111n });
    expect(mocks.destroy).not.toHaveBeenCalled();
    await expect(waitForMint(sent)).resolves.toMatchObject({ status: 1 });
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
});

describe("confirmation and user errors", () => {
  it("accepts a speed-up transaction with the same intent", async () => {
    const receipt = { status: 1, hash: "0xreplacement" };
    const sent = transaction();
    sent.wait.mockRejectedValue({ code: "TRANSACTION_REPLACED", cancelled: false, replacement: transaction(), receipt });
    await expect(waitForMint(sent)).resolves.toBe(receipt);
  });

  it.each([
    { cancelled: true, replacement: transaction() },
    { cancelled: false, replacement: transaction({ data: "0x" }) },
  ])("does not report an unrelated or cancelled replacement as a successful mint", async (replacement) => {
    const sent = transaction();
    sent.wait.mockRejectedValue({ code: "TRANSACTION_REPLACED", ...replacement, receipt: { status: 1 } });
    await expect(waitForMint(sent)).rejects.toMatchObject({ code: "MINT_REPLACED" });
  });

  it("rejects failed receipts", async () => {
    await expect(waitForMint(transaction({ wait: vi.fn().mockResolvedValue({ status: 0 }) }))).rejects.toMatchObject({ code: "MINT_FAILED" });
  });

  it("explains a rejection nested inside an ethers provider error", () => {
    expect(formatWalletError({ code: "UNKNOWN_ERROR", info: { error: { code: 4001 } } })).toContain("Request rejected");
    expect(formatWalletError({ code: "INSUFFICIENT_FUNDS" })).toContain("test ETH");
    expect(formatWalletError({ code: "TIMEOUT" })).toContain("may still be pending");
  });
});
