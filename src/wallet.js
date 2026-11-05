import { BrowserProvider, Contract, ZeroAddress, getAddress, isAddress } from "ethers";

// Keep the provider alive while a transaction is being confirmed, then dispose it.
const transactionProviders = new WeakMap();

function walletError(code, message) {
  return Object.assign(new Error(message), { code });
}

function errorCodes(error) {
  const codes = new Set();
  const seen = new Set();
  const pending = [error];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (value.code !== undefined) codes.add(String(value.code));
    pending.push(value.error, value.data, value.originalError, value.info?.error);
  }
  return codes;
}

function requireProvider(ethereum) {
  if (!ethereum || typeof ethereum.request !== "function") {
    throw walletError("NO_WALLET", "MetaMask was not detected. Install or enable it in this browser, then reload.");
  }
}

function expectedChainId(network) {
  try {
    const chainId = BigInt(network.chainId);
    if (chainId <= 0n) throw new Error();
    return chainId;
  } catch {
    throw walletError("INVALID_CONFIG", "The configured network chain ID is invalid.");
  }
}

function checkedAddress(address) {
  if (!isAddress(address) || address.toLowerCase() === ZeroAddress) {
    throw walletError("INVALID_CONFIG", "Configure the deployed TicketNFT contract address first.");
  }
  return getAddress(address);
}

async function assertChain(ethereum, network) {
  requireProvider(ethereum);
  const expected = expectedChainId(network);
  const actual = await ethereum.request({ method: "eth_chainId" });
  if (BigInt(actual) !== expected) {
    throw walletError("WRONG_CHAIN", `Switch your wallet to ${network.chainName} before continuing.`);
  }
}

async function assertAccount(ethereum, account) {
  if (!isAddress(account)) {
    throw walletError("INVALID_ACCOUNT", "Connect a wallet account before claiming.");
  }
  const accounts = await ethereum.request({ method: "eth_accounts" });
  if (!accounts[0] || accounts[0].toLowerCase() !== account.toLowerCase()) {
    throw walletError("ACCOUNT_CHANGED", "The selected wallet account changed. Refresh the wallet status and try again.");
  }
}

async function assertContract(provider, address, network) {
  if ((await provider.getCode(address)) === "0x") {
    throw walletError("NO_CONTRACT", `No contract exists at this address on ${network.chainName}. Check the deployment and address.`);
  }
}

export function getInjectedProvider() {
  const injected = globalThis.window?.ethereum;
  return injected?.providers?.find((provider) => provider.isMetaMask) ?? injected;
}

// Called only in response to a user's Connect/Switch action, never during reads.
export async function ensureChain(ethereum, network) {
  requireProvider(ethereum);
  const chainId = `0x${expectedChainId(network).toString(16)}`;
  const current = await ethereum.request({ method: "eth_chainId" });
  if (BigInt(current) === BigInt(chainId)) return;

  try {
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (error) {
    if (!errorCodes(error).has("4902")) throw error;
    if (!network.rpcUrl) {
      throw walletError("INVALID_CONFIG", `Add ${network.chainName} to your wallet before continuing.`);
    }
    const chain = {
      chainId,
      chainName: network.chainName,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: [network.rpcUrl],
      ...(network.explorerUrl ? { blockExplorerUrls: [network.explorerUrl] } : {}),
    };
    await ethereum.request({ method: "wallet_addEthereumChain", params: [chain] });
    // Adding a network does not guarantee the wallet selected it.
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  }
  await assertChain(ethereum, network);
}

export async function readClaimState(ethereum, account, config) {
  const address = checkedAddress(config.address);
  await assertChain(ethereum, config.network);
  if (!isAddress(account)) throw walletError("INVALID_ACCOUNT", "Connect a wallet account before querying tickets.");
  const provider = new BrowserProvider(ethereum, undefined, { cacheTimeout: -1 });
  try {
    await assertContract(provider, address, config.network);
    const contract = new Contract(address, config.abi, provider);
    const [hasMinted, balance] = await Promise.all([
      contract.hasMinted(account),
      contract.balanceOf(account),
    ]);
    // A wallet can change chains while the two requests are in flight.
    await assertChain(ethereum, config.network);
    return { hasMinted, balance };
  } finally {
    provider.destroy();
  }
}

export async function sendMintTransaction(ethereum, account, config) {
  const address = checkedAddress(config.address);
  await assertChain(ethereum, config.network);
  await assertAccount(ethereum, account);
  const provider = new BrowserProvider(ethereum, undefined, { cacheTimeout: -1 });
  try {
    await assertContract(provider, address, config.network);
    const signer = await provider.getSigner(account);
    const contract = new Contract(address, config.abi, signer);
    if (await contract.hasMinted(account)) {
      throw walletError("ALREADY_CLAIMED", "This wallet has already claimed its NFT. Transferring the NFT does not reset eligibility.");
    }
    await assertChain(ethereum, config.network);
    await assertAccount(ethereum, account);
    // Bind the request to this chain even if the wallet changes during approval.
    const transaction = await contract.mint({ chainId: expectedChainId(config.network) });
    transactionProviders.set(transaction, provider);
    return transaction;
  } catch (error) {
    provider.destroy();
    throw error;
  }
}

function sameTransactionIntent(original, replacement) {
  return replacement
    && original.to?.toLowerCase() === replacement.to?.toLowerCase()
    && original.from?.toLowerCase() === replacement.from?.toLowerCase()
    && original.data === replacement.data
    && BigInt(original.value ?? 0) === BigInt(replacement.value ?? 0);
}

export async function waitForMint(transaction) {
  try {
    let receipt;
    try {
      receipt = await transaction.wait(1, 180_000);
    } catch (error) {
      if (error.code !== "TRANSACTION_REPLACED") throw error;
      if (error.cancelled || !sameTransactionIntent(transaction, error.replacement)) {
        throw walletError("MINT_REPLACED", "The mint transaction was cancelled or replaced by a different transaction. Refresh the claim status before trying again.");
      }
      receipt = error.receipt;
    }
    if (!receipt || Number(receipt.status) !== 1) {
      throw walletError("MINT_FAILED", "The mint transaction did not succeed. Refresh the claim status before trying again.");
    }
    return receipt;
  } finally {
    transactionProviders.get(transaction)?.destroy();
    transactionProviders.delete(transaction);
  }
}

export function formatWalletError(error) {
  const codes = errorCodes(error);
  const ownCodes = ["NO_WALLET", "INVALID_CONFIG", "WRONG_CHAIN", "INVALID_ACCOUNT", "ACCOUNT_CHANGED", "NO_CONTRACT", "ALREADY_CLAIMED", "MINT_REPLACED", "MINT_FAILED"];
  if (ownCodes.some((code) => codes.has(code))) return error.message;
  if (codes.has("4001") || codes.has("ACTION_REJECTED")) return "Request rejected in the wallet. You can try again when ready.";
  if (codes.has("-32002")) return "A wallet request is already pending. Open MetaMask and finish or cancel it first.";
  if (codes.has("INSUFFICIENT_FUNDS")) return "This wallet needs test ETH on the selected network to pay the transaction gas fee.";
  if (codes.has("4900") || codes.has("4901")) return "The wallet is disconnected from the network. Reconnect it and refresh the status.";
  if (codes.has("TIMEOUT")) return "Confirmation is taking longer than expected. The transaction may still be pending; check its hash and refresh the claim status.";
  const message = String(error?.reason ?? error?.shortMessage ?? error?.message ?? "");
  if (/one ticket per wallet|already claimed/i.test(message)) return "This wallet has already claimed its NFT. Each wallet may claim only once.";
  if (/insufficient funds/i.test(message)) return "This wallet needs test ETH on the selected network to pay the transaction gas fee.";
  if (codes.has("CALL_EXCEPTION")) return "The contract rejected this operation. Check the TicketNFT address, network and existing claim status.";
  if (codes.has("BAD_DATA")) return "The configured address does not respond as a TicketNFT contract. Check its address and network.";
  if (codes.has("NETWORK_ERROR") || codes.has("SERVER_ERROR")) return "Could not reach the selected blockchain network. Check the wallet network and RPC connection, then retry.";
  return "The wallet or network request failed. Check MetaMask and your connection, then refresh the status and retry.";
}
