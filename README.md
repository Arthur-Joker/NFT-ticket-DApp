# NFT Ticket Claim

A minimal React + Vite + ethers v6 DApp. Each wallet can claim one free ERC-721
ticket. The contract enforces the rule; the page reads that rule back from the
blockchain after connection, refresh, account changes and successful transactions.
Minting requires network gas even though the ticket itself has no price.

This project implements the tutorial `TicketNFT` example with a complete wallet
interaction flow and local development/test tooling.

## Current deployment status

The application is configured for the user's Sepolia TicketNFT deployment:
[`0xff0923dbdb576fda451e77794cba1f8cb5d43fc9`](https://sepolia.etherscan.io/address/0xff0923dbdb576fda451e77794cba1f8cb5d43fc9).
Read-only RPC checks confirmed contract code, the collection name/symbol, ERC-721
support, claim queries and a successful mint simulation. Public-chain wallet
approval and a real Sepolia mint remain manual verification steps.

The default `npm run dev` targets Sepolia. This workspace's `.env` is configured;
on a fresh checkout, copy `.env.example` to `.env` to use the same public deployment.
Local mode is available without changing `.env`.

The page uses a compact responsive claim card, wallet eligibility and transaction
feedback. On narrow screens, the primary action appears before the illustrative
ticket. The illustration is a page graphic, not hosted NFT artwork. An in-app
preview may have no wallet extension; open the same local URL in your MetaMask
browser profile to connect and sign.

## Requirements

- Node.js **24 LTS** recommended (development checked with 24.15.0), npm.
- MetaMask or another injected EIP-1193 desktop browser wallet for manual use.
- For Sepolia: a small amount of Sepolia test ETH for deployment and mint gas.
- For automated browser smoke tests only: Playwright's Chromium, or installed Chrome.

Run all commands from the repository root. On Windows PowerShell, use `npm.cmd`
if execution policy prevents `npm.ps1` from running.

```powershell
git clone https://github.com/jzjzzzzzzz/nft-ticket-dapp.git
cd nft-ticket-dapp
npm.cmd ci
Copy-Item .env.example .env
npm.cmd run dev
```

Open the local URL printed by Vite in the browser profile with MetaMask. The
template already points to the public Sepolia deployment above. To check the
source independently, run `npm.cmd test` and `npm.cmd run build`.

## Deploy TicketNFT on Sepolia with Remix

1. Open [Remix](https://remix.ethereum.org/) and create `TicketNFT.sol`.
2. Copy the complete contents of `contracts/TicketNFT.sol` into it. Its import pins
   OpenZeppelin **5.6.1** and works directly in Remix.
3. Choose Solidity compiler **0.8.30**, EVM target **Cancun**, and enable optimizer
   with **200 runs** to match the local compilation settings. Compile `TicketNFT`.
4. In MetaMask select **Sepolia** and the account holding test ETH.
5. In Remix's **Deploy & Run Transactions**, choose the browser extension/injected
   wallet environment. Confirm chain ID **11155111**. A Remix VM deployment will
   not be accessible to the frontend on Sepolia.
6. Select **TicketNFT**. There are **no constructor arguments**; leave Value at **0**.
7. Click Deploy and approve the transaction yourself in MetaMask.
8. After confirmation, copy the deployed **contract address**, not the account
   address or deployment transaction hash.

Create your frontend configuration:

```powershell
Copy-Item .env.example .env
```

Edit `.env`:

```dotenv
VITE_CONTRACT_ADDRESS=0xff0923dbdb576fda451e77794cba1f8cb5d43fc9
VITE_CHAIN_ID=11155111
```

Replace that address if you deploy your own instance. These values are public; Vite includes
`VITE_` variables in browser code. No private key, recovery phrase or wallet export
is needed anywhere in this project.

```powershell
npm.cmd run dev
```

Open the URL printed by Vite in the browser profile with MetaMask. Restart Vite
after changing `.env`. Connect the wallet, approve a network switch if requested,
and click **Claim NFT**. Confirm the transaction in MetaMask. The page shows the
submitted hash, waits for confirmation, displays the token ID and reloads eligibility.
The Sepolia transaction link opens Etherscan.

If a previous `.env.local` exists, its values override `.env`; remove its local-chain
settings or update it before testing Sepolia. `dev:local` below creates neither file.

## Run completely on a local development chain

This checks real contract execution without requiring a public-network deployment.
The local chain is temporary: restarting it clears deployments and tickets.

Terminal 1, keep it running:

```powershell
npm.cmd run chain
```

Terminal 2:

```powershell
npm.cmd run deploy:local
npm.cmd run dev:local
```

`deploy:local` only connects to `127.0.0.1:8545`, checks chain ID **31337** and
the Hardhat node identity, uses an unlocked local development account, and saves
the public address to `deployments/localhost.json`. It never reads a private key.
`dev:local` reads that address and starts the page at `http://127.0.0.1:5173` using
the local chain, without editing your Sepolia `.env`.

For manual browser use, select/add the local Hardhat network (RPC
`http://127.0.0.1:8545`, chain ID `31337`, currency `ETH`). The page can request this
when you connect/switch. Use a **disposable, locally funded test account**. The local
chain accounts printed by Hardhat are public development accounts; use them only
on this temporary local chain. Alternatively, use the automated browser test below,
which requires no wallet extension or account import.

After restarting the chain, run `deploy:local` again and restart `dev:local`.
If the port is already occupied, stop the earlier local server before restarting it.

## Verification commands

| Command | Checks or runs |
| --- | --- |
| `npm run contract:compile` | Compile Solidity with pinned npm solc and OpenZeppelin; write `artifacts/TicketNFT.json`. |
| `npm run deployment:check` | Read-only Sepolia contract/interface checks; writes `artifacts/sepolia-verification.json`. No transaction is sent. |
| `npm run test:contract` | Real in-process Hardhat EVM: mint, duplicate rejection, transfers, callback rollback and reentry. No node needs to be running. |
| `npm run test:frontend` | Wallet error/network handling and React interaction/state tests. |
| `npm test` | Contract and frontend tests together. |
| `npm run build` | Build the static frontend in `dist/`. |
| `npm run preview` | Serve that build; requires deployment values set before building. |
| `npm run test:e2e` | Real browser + local Hardhat execution, using a simulated wallet approval bridge. Requires `npm run chain` in another terminal. |

For the browser smoke test, install its browser once:

```powershell
npx.cmd playwright install chromium
npm.cmd run test:e2e
```

Or use an already installed Chrome on Windows:

```powershell
$env:PLAYWRIGHT_CHANNEL = 'chrome'
npm.cmd run test:e2e
```

The smoke test starts its own Vite server at `127.0.0.1:5174`, deploys a fresh local
test contract, and checks two wallets minting, actual NFT ownership, page reload,
account switching and wrong-network recovery. It closes its browser/server when
done and writes `artifacts/browser-smoke.json` plus a screenshot. Wallet approvals
are **simulated** in this test; it does not prove the MetaMask extension or Sepolia
workflow. It does not change `.env` or the `deploy:local` deployment record.

## Sepolia manual acceptance checklist

- Connect wallet A and confirm the page reads the selected account and Sepolia.
- Reject one mint request: the page should show rejection and allow retry.
- Confirm the next request: check the receipt in Etherscan and token ownership.
- Reload: wallet A remains already claimed without an automatic approval popup.
- Switch to wallet B: its own eligibility appears; it can claim its own NFT.
- Switch away from Sepolia: claiming is blocked until the correct network is selected.
- Check a zero-ETH account: an insufficient-gas operation must not report success.
- Optionally transfer wallet A's NFT using an ERC-721 interface: A remains ineligible,
  although its held balance is now zero. Receiving an NFT does not consume B's own claim.

Do not record these as passed until actually performed on the deployed Sepolia instance.

## How the pieces work

```text
index.html -> src/main.jsx -> React App
                                |
                    contract.js (address, ABI, network)
                                |
                       wallet.js + ethers
                                |
                   browser wallet -> RPC node -> TicketNFT
```

- `contracts/TicketNFT.sol`: ERC-721, sequential IDs starting at 1, `hasMinted`
  mapping and the `Mint` event. Marks eligibility before a receiver callback; a
  failed transaction rolls back all changes. There is no privileged admin path.
- `src/contract.js`: public configuration and the ABI signatures used by the UI.
  Sepolia is the default; only Sepolia and the local test chain are supported.
- `src/wallet.js`: connection helpers, chain/account checks, contract existence
  checks, reads, mint submission, receipt/replacement handling and useful error text.
- `src/App.jsx`: connection UI, claim status, pending/confirmed transaction display
  and subscriptions to wallet events. Late results from a previous wallet session
  are ignored. Listeners are removed when the component is unmounted.
- `src/main.jsx`: mounts React into the HTML root.
- `scripts/`: local compilation, local-only deployment, local UI and browser checks.

The blockchain is the source of truth. There is no separate API server, database
or local-storage claim flag. Refreshing the page cannot reset the contract rule.
One wallet is not necessarily one person. The NFT currently has token IDs and
ownership, but no hosted artwork/metadata; it may appear without an image in a wallet.

## Common problems

- **Setup needed:** supply the TicketNFT address in `.env`, then restart Vite.
- **No contract exists:** wrong chain, wrong address, or a restarted local chain.
- **Contract does not respond as TicketNFT:** the address points to another contract.
- **Wallet not detected:** enable MetaMask and reload in the same browser profile.
- **Wrong network:** use the explicit Switch button; cancelling leaves mint disabled.
- **Request pending:** finish or cancel the existing MetaMask prompt.
- **Confirmation timeout:** check the displayed hash and refresh status before retrying;
  a timeout does not imply the on-chain transaction failed.

## References

The production dependencies passed `npm audit --omit=dev` on 2026-11-05. The full
development toolchain still has 5 audit findings through Hardhat/Zod and solc/tmp.
Compatible Vite and transitive dependency fixes were applied. The remaining
upstream fixes require incompatible tool/compiler changes; the solc SMT temporary
file helper is not used by this project's compilation API. Keep local development
servers on loopback, as the provided local scripts do. See `PROGRESS.md` for the
verification record.

- [MetaMask provider API](https://docs.metamask.io/wallet/reference/provider-api/)
- [ethers v6 providers](https://docs.ethers.org/v6/api/providers/)
- [OpenZeppelin ERC-721](https://docs.openzeppelin.com/contracts/5.x/api/token/erc721)
- [Hardhat local node](https://hardhat.org/docs/guides/local-node)
