import { useCallback, useEffect, useRef, useState } from "react";
import { Interface } from "ethers";
import { CONTRACT_CONFIG } from "./contract.js";
import {
  ensureChain, formatWalletError, getInjectedProvider,
  readClaimState, sendMintTransaction, waitForMint,
} from "./wallet.js";

const emptyWallet = { account: "", chainId: "", claim: null, balance: null, reading: false, error: "" };

export default function App({ config = CONTRACT_CONFIG }) {
  const [ethereum] = useState(getInjectedProvider);
  const [wallet, setWallet] = useState(emptyWallet);
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState("");
  const [transaction, setTransaction] = useState(null);
  const mounted = useRef(false);
  const readVersion = useRef(0);
  const actionVersion = useRef(0);
  const busyRef = useRef("");
  const correctChain = Boolean(config.network && wallet.chainId &&
    BigInt(wallet.chainId) === BigInt(config.network.chainId));

  // Restore already-authorized accounts without opening a wallet approval popup.
  const refresh = useCallback(async () => {
    if (!ethereum) return;
    const version = ++readVersion.current;
    const current = () => mounted.current && version === readVersion.current;
    setWallet((previous) => ({ ...previous, reading: true, claim: null, balance: null, error: "" }));
    try {
      const [accounts, chainId] = await Promise.all([
        ethereum.request({ method: "eth_accounts" }),
        ethereum.request({ method: "eth_chainId" }),
      ]);
      if (!current()) return;
      const account = accounts[0] ?? "";
      setWallet({ ...emptyWallet, account, chainId, reading: true });
      if (!account || config.error || !config.network ||
          BigInt(chainId) !== BigInt(config.network.chainId)) return;
      const result = await readClaimState(ethereum, account, config);
      if (current()) setWallet({
        account, chainId, claim: result.hasMinted,
        balance: result.balance, reading: false, error: "",
      });
    } catch (error) {
      if (current()) setWallet((previous) => ({
        ...previous, claim: null, balance: null, error: formatWalletError(error),
      }));
    } finally {
      if (current()) setWallet((previous) => ({ ...previous, reading: false }));
    }
  }, [ethereum, config]);

  useEffect(() => {
    mounted.current = true;
    if (!ethereum) return () => { mounted.current = false; };
    function changed(message) {
      ++readVersion.current;
      // Connect/switch actions intentionally cause wallet events. A pending mint
      // belongs to the old account/network and must not update the new session.
      if (!["connecting", "switching"].includes(busyRef.current)) {
        ++actionVersion.current;
        busyRef.current = "";
        setBusy("");
      }
      setTransaction(null);
      setStatus(message);
      setWallet((previous) => ({ ...previous, claim: null, balance: null, reading: true, error: "" }));
      void refresh();
    }
    const accountsChanged = () => changed("Wallet account changed. Claim eligibility is being checked again.");
    const chainChanged = () => changed("Wallet network changed. Check the selected network before claiming.");
    const connected = () => { void refresh(); };
    const disconnected = () => {
      ++readVersion.current;
      ++actionVersion.current;
      busyRef.current = "";
      setBusy("");
      setWallet(emptyWallet);
      setTransaction(null);
      setStatus("Wallet disconnected. Reconnect your wallet to continue.");
    };
    ethereum.on?.("accountsChanged", accountsChanged);
    ethereum.on?.("chainChanged", chainChanged);
    ethereum.on?.("connect", connected);
    ethereum.on?.("disconnect", disconnected);
    void refresh();
    return () => {
      mounted.current = false;
      ++readVersion.current;
      ++actionVersion.current;
      ethereum.removeListener?.("accountsChanged", accountsChanged);
      ethereum.removeListener?.("chainChanged", chainChanged);
      ethereum.removeListener?.("connect", connected);
      ethereum.removeListener?.("disconnect", disconnected);
    };
  }, [ethereum, refresh]);

  async function connectWallet() {
    if (!ethereum) {
      setStatus("No browser wallet found. Install or enable MetaMask, then reload this page.");
      return;
    }
    if (busyRef.current) return;
    const version = ++actionVersion.current;
    busyRef.current = "connecting";
    setBusy("connecting");
    setStatus("Approve the connection in your wallet.");
    try {
      const accounts = await ethereum.request({ method: "eth_requestAccounts" });
      if (!accounts.length) throw new Error("No wallet account was selected.");
      if (config.network) await ensureChain(ethereum, config.network);
      if (mounted.current && version === actionVersion.current) {
        setStatus("Wallet connected. Read your claim status below.");
        await refresh();
      }
    } catch (error) {
      if (mounted.current && version === actionVersion.current) {
        setStatus(formatWalletError(error));
        await refresh();
      }
    } finally {
      if (mounted.current && version === actionVersion.current) {
        busyRef.current = "";
        setBusy("");
      }
    }
  }

  async function switchNetwork() {
    if (!ethereum || !config.network || busyRef.current) return;
    const version = ++actionVersion.current;
    busyRef.current = "switching";
    setBusy("switching");
    try {
      await ensureChain(ethereum, config.network);
      if (mounted.current && version === actionVersion.current) {
        setStatus(`Switched to ${config.network.chainName}.`);
        await refresh();
      }
    } catch (error) {
      if (mounted.current && version === actionVersion.current) setStatus(formatWalletError(error));
    } finally {
      if (mounted.current && version === actionVersion.current) {
        busyRef.current = "";
        setBusy("");
      }
    }
  }

  async function mint() {
    if (busyRef.current || wallet.reading || wallet.claim !== false || !correctChain || config.error) return;
    const version = ++actionVersion.current;
    const current = () => mounted.current && version === actionVersion.current;
    const account = wallet.account;
    busyRef.current = "minting";
    setBusy("minting");
    setTransaction(null);
    setStatus("Confirm the NFT claim in your wallet. The NFT is free; network gas is required.");
    try {
      const tx = await sendMintTransaction(ethereum, account, config);
      if (current()) {
        setTransaction({ hash: tx.hash });
        setStatus("Transaction submitted. Waiting for a block confirmation...");
      }
      // Always finish watching submitted transactions, even after an account switch.
      const receipt = await waitForMint(tx);
      if (!current()) return;
      const abi = new Interface(config.abi);
      const event = receipt.logs
        .filter((log) => log.address.toLowerCase() === config.address.toLowerCase())
        .map((log) => { try { return abi.parseLog(log); } catch { return null; } })
        .find((log) => log?.name === "Mint" && log.args.minter.toLowerCase() === account.toLowerCase());
      setTransaction({ hash: receipt.hash, tokenId: event?.args.tokenId.toString() });
      setStatus(event ? `NFT #${event.args.tokenId} claimed successfully.` :
        "Transaction confirmed. Refreshing the contract's claim record.");
      await refresh();
    } catch (error) {
      if (current()) {
        setStatus(formatWalletError(error));
        await refresh();
      }
    } finally {
      if (current()) {
        busyRef.current = "";
        setBusy("");
      }
    }
  }

  const networkName = config.network?.chainName ?? "the configured network";
  const claimLabel = wallet.reading ? "Checking on-chain status..." : wallet.claim === true ? "Already claimed" : wallet.claim === false ? "Eligible to claim" : "Not checked";
  const confirmed = Boolean(transaction?.tokenId);
  const statusTone = confirmed ? "success" : /rejected|failed|needs|could not|no browser|taking longer/i.test(status) ? "warning" : "info";
  const shortContract = config.address ? `${config.address.slice(0, 8)}…${config.address.slice(-6)}` : "";

  return (
    <main className="app-shell">
      <header className="site-header">
        <a className="brand" href="#" aria-label="NFT Ticket home">
          <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M4 6.5h16v4a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4v-4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M15 7v2m0 2v2m0 2v2" stroke="currentColor" strokeWidth="1.7"/></svg></span>
          NFT Ticket
        </a>
        <div className="header-right"><a className="help-link" href="#how-it-works">How it works</a><span className="network-pill"><span aria-hidden="true" />{networkName}</span></div>
      </header>

      <section className="page-intro" aria-labelledby="page-title">
        <p className="eyebrow">A SMALL TICKET. A REAL ON-CHAIN MOMENT.</p>
        <h1 id="page-title">Your next ticket,<br /><span>on the blockchain.</span></h1>
        <p className="intro-copy">Claim your free NFT ticket on {networkName}. Connect your wallet, confirm once, and make it yours.</p>
      </section>

      {config.error && <p className="notice" role="alert">{config.error}</p>}
      {config.network?.chainId === "0x7a69" && <p className="notice local-notice">Local development chain. These NFTs exist only on your computer while the local node is running.</p>}

      <section className="claim-layout" aria-label="NFT ticket and claim">
        <div className="ticket-panel">
          <div className="preview-heading"><span className="eyebrow">THE COLLECTION</span><span className="collection-type">ERC-721</span></div>
          <div className={`ticket-preview ${wallet.claim ? "ticket-preview--claimed" : ""}`} aria-label="Illustrative NFT ticket preview">
            <div className="ticket-topline"><span className="ticket-mini-brand">NFT / TICKET</span><span className="ticket-orbit" aria-hidden="true">✳</span></div>
            <div className="ticket-center"><span className="ticket-kicker">YOUR ON-CHAIN</span><span className="ticket-word">TICKET</span><span className="ticket-edition">One wallet. One claim.</span></div>
            <div className="ticket-perforation" aria-hidden="true" />
            <div className="ticket-bottom"><div><span className="ticket-small-label">NETWORK</span><span>{networkName}</span></div><div className="ticket-barcode" aria-hidden="true" /></div>
          </div>
          <p className="preview-caption">Illustrative preview · NFT ownership is recorded on-chain.</p>
          <div className="ticket-facts"><div><span>Mint price</span><strong>Free</strong></div><div><span>Claim limit</span><strong>1 per wallet</strong></div><div><span>Standard</span><strong>ERC-721</strong></div></div>
        </div>

        <div className="claim-card">
          <div className="card-heading"><span className="eyebrow">CLAIM YOUR TICKET</span><span className={`connection-dot ${wallet.account ? "is-connected" : ""}`} aria-hidden="true" /></div>
          <h2>{wallet.claim === true ? "Your claim is recorded." : wallet.account ? "You're connected." : "Make it yours."}</h2>
          <p className="card-intro">{wallet.claim === true ? "This wallet has used its claim. Your ticket ownership is stored on the blockchain." : wallet.account ? "Check your wallet's eligibility below, then confirm the claim in your wallet." : "Start by connecting your wallet. Connecting is free and does not send a transaction."}</p>

          {!wallet.account ? (
            <>
              <div className="wallet-placeholder"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M4 7h15a1 1 0 0 1 1 1v11H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h13v3" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M20 11h-5v5h5M16.5 13.5h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg><span>Wallet not connected</span></div>
              <button className="button button-primary" onClick={connectWallet} disabled={Boolean(busy)}>{busy === "connecting" ? "Connecting..." : "Connect MetaMask"}</button>
              {!ethereum && <p className="wallet-help">MetaMask was not detected. Open this page in a browser with the extension enabled, then reload. <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">Get MetaMask <span aria-hidden="true">↗</span></a></p>}
            </>
          ) : (
            <>
              <dl className="wallet-details">
                <div className="wallet-account"><dt>Connected wallet</dt><dd><code>{wallet.account}</code></dd></div>
                <div><dt>Network</dt><dd className={!correctChain ? "text-warning" : ""}>{correctChain ? config.network.chainName : `Wrong network (chain ${wallet.chainId ? BigInt(wallet.chainId).toString() : "unknown"})`}</dd></div>
                <div><dt>Claim eligibility</dt><dd className={`eligibility ${wallet.claim === true ? "is-claimed" : wallet.claim === false ? "is-eligible" : ""}`}>{claimLabel}</dd></div>
                {wallet.balance !== null && <div><dt>NFTs currently held</dt><dd>{wallet.balance.toString()}</dd></div>}
              </dl>
              {!correctChain && config.network && <button className="button button-switch" onClick={switchNetwork} disabled={Boolean(busy)}>Switch to {config.network.chainName}</button>}
              <button className={`button button-primary ${wallet.claim === true ? "button-claimed" : ""}`} onClick={mint} disabled={Boolean(busy) || wallet.reading || wallet.claim !== false || !correctChain || Boolean(config.error)}>
                {busy === "minting" ? "Processing claim..." : wallet.claim === true ? "NFT already claimed" : "Claim NFT"}
              </button>
              <button className="button button-text" onClick={() => { void refresh(); }} disabled={Boolean(busy) || wallet.reading}>Refresh status</button>
            </>
          )}
          <p className="gas-note"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none"><path d="m8 1 5 2v4c0 3-5 7-5 7S3 10 3 7V3l5-2Z" stroke="currentColor" strokeWidth="1.2"/><path d="m5.5 7 1.7 1.7 3.3-3.4" stroke="currentColor" strokeWidth="1.2"/></svg>Free to mint. A small testnet gas fee applies.</p>
          {wallet.error && <p className="notice" role="alert">{wallet.error}</p>}
          {status && <p className={`status status--${statusTone}`} role="status">{status}</p>}
          {transaction && <div className={`transaction-box ${confirmed ? "transaction-box--success" : ""}`}>
            <div className="transaction-heading"><span>{confirmed ? "Claim confirmed" : "Your transaction"}</span>{confirmed && <span aria-hidden="true">✓</span>}</div>
            {transaction.tokenId && <p className="token-id">Minted token ID: <strong>{transaction.tokenId}</strong></p>}
            <p className="transaction-hash"><span>Transaction</span><code>{transaction.hash}</code></p>
            {config.network?.explorerUrl && <a href={`${config.network.explorerUrl}/tx/${transaction.hash}`} target="_blank" rel="noreferrer">View transaction on Etherscan<span aria-hidden="true"> ↗</span></a>}
          </div>}
        </div>
      </section>

      <section className="how-section" id="how-it-works" aria-labelledby="how-title">
        <div className="section-heading"><h2 id="how-title">Three simple steps.</h2><p>Your wallet stays in control.</p></div>
        <ol className="steps"><li><span className="step-number">01</span><div><h3>Connect your wallet</h3><p>Use MetaMask and select {networkName}.</p></div></li><li><span className="step-number">02</span><div><h3>Confirm your claim</h3><p>Review the transaction and gas fee in your wallet.</p></div></li><li><span className="step-number">03</span><div><h3>Keep your ticket</h3><p>After confirmation, ownership is recorded on-chain.</p></div></li></ol>
      </section>

      <footer className="site-footer">
        <div className="footer-top"><span className="footer-brand">NFT Ticket</span>{!config.error && <div className="contract-reference"><span>Contract</span>{config.network?.explorerUrl ? <a href={`${config.network.explorerUrl}/address/${config.address}`} target="_blank" rel="noreferrer" title={config.address}>{shortContract}<span aria-hidden="true"> ↗</span></a> : <code title={config.address}>{shortContract}</code>}</div>}</div>
        <details className="ticket-notes"><summary>About this ticket</summary><p>The contract remembers whether this wallet has claimed. Refreshing the page or transferring the NFT does not create another claim. A wallet that receives a transferred NFT can still use its own unused claim.</p><p>This example records NFT ownership and token IDs; it does not provide artwork or hosted NFT metadata.</p>{!config.error && <p>Contract: <code>{config.address}</code></p>}</details>
      </footer>
    </main>
  );
}
