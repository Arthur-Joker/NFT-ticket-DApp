import { readFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Contract, FetchRequest, JsonRpcProvider, getAddress, keccak256 } from "ethers";
import solc from "solc";
import { projectRoot } from "./compile-contract.mjs";

// Read-only RPC verification. This script never creates a signer or broadcasts.
const address = getAddress(process.argv[2] ?? process.env.VITE_CONTRACT_ADDRESS ?? "0xff0923dbdb576fda451e77794cba1f8cb5d43fc9");
const endpoints = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org",
  "https://rpc.sepolia.org",
];
const probe = "0x1111111111111111111111111111111111111111";
const abi = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function supportsInterface(bytes4) view returns (bool)",
  "function hasMinted(address) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function mint() returns (uint256)",
];

function executableCode(bytecode) {
  // Solidity appends CBOR metadata followed by a two-byte metadata length.
  const metadataBytes = Number.parseInt(bytecode.slice(-4), 16);
  return Number.isFinite(metadataBytes) && metadataBytes * 2 + 4 < bytecode.length - 2
    ? bytecode.slice(0, -(metadataBytes * 2 + 4)).toLowerCase()
    : bytecode.toLowerCase();
}

async function compareUnoptimizedSource(chainCode) {
  // Remix defaults to optimization disabled. Compare that build without
  // changing the project's optimized compilation defaults or artifact.
  const input = {
    language: "Solidity",
    sources: { "contracts/TicketNFT.sol": { content: await readFile(resolve(projectRoot, "contracts/TicketNFT.sol"), "utf8") } },
    settings: {
      optimizer: { enabled: false, runs: 200 }, evmVersion: "cancun",
      outputSelection: { "*": { "*": ["evm.deployedBytecode.object"] } },
    },
  };
  const compiled = JSON.parse(solc.compile(JSON.stringify(input), {
    import(name) {
      const prefix = "@openzeppelin/contracts@5.6.1/";
      if (!name.startsWith(prefix) || name.includes("..")) return { error: `Unsupported import ${name}` };
      try { return { contents: readFileSync(resolve(projectRoot, "node_modules/@openzeppelin/contracts", name.slice(prefix.length)), "utf8") }; }
      catch { return { error: `Import not found: ${name}` }; }
    },
  }));
  const errors = (compiled.errors ?? []).filter((entry) => entry.severity === "error");
  if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
  const runtime = `0x${compiled.contracts["contracts/TicketNFT.sol"].TicketNFT.evm.deployedBytecode.object}`;
  return {
    compilerVersion: solc.version(), optimizerEnabled: false, evmVersion: "cancun",
    executableRuntimeMatch: executableCode(runtime) === executableCode(chainCode),
    executableRuntimeHash: keccak256(executableCode(chainCode)),
    ignoredSolidityMetadata: true,
  };
}

const failures = [];
let result;
for (const url of endpoints) {
  let provider;
  try {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const chain = await response.json();
    if (chain.error || BigInt(chain.result) !== 11155111n) throw new Error("Endpoint did not confirm Sepolia chain ID11155111.");
    const request = new FetchRequest(url);
    request.timeout = 12_000;
    provider = new JsonRpcProvider(request, 11155111, { staticNetwork: true });
    const code = await provider.getCode(address);
    if (code === "0x") throw new Error("No bytecode is deployed at the supplied address on Sepolia.");
    const contract = new Contract(address, abi, provider);
    const [name, symbol, erc721, hasMinted, balance] = await Promise.all([
      contract.name(), contract.symbol(), contract.supportsInterface("0x80ac58cd"),
      contract.hasMinted(probe), contract.balanceOf(probe),
    ]);
    if (!erc721) throw new Error("The contract does not report ERC-721 support.");
    const simulatedMintId = hasMinted ? null : (await contract.mint.staticCall({ from: probe })).toString();
    let exactRuntimeMatch = null;
    let executableRuntimeMatch = null;
    try {
      const artifact = JSON.parse(await readFile(resolve(projectRoot, "artifacts/TicketNFT.json"), "utf8"));
      exactRuntimeMatch = code.toLowerCase() === artifact.deployedBytecode.toLowerCase();
      executableRuntimeMatch = executableCode(code) === executableCode(artifact.deployedBytecode);
    } catch {
      // ABI verification remains useful when the optional local artifact is absent.
    }
    const unoptimizedSourceComparison = executableRuntimeMatch ? null : await compareUnoptimizedSource(code);
    result = {
      checkedAt: new Date().toISOString(), chainId: 11155111, address, rpcUrl: url,
      bytecodeBytes: (code.length - 2) / 2, name, symbol, erc721,
      probe: { address: probe, hasMinted, balance: balance.toString() },
      mintSimulation: simulatedMintId === null ? "not attempted: probe already claimed" : { tokenId: simulatedMintId, readOnly: true },
      localBytecodeComparison: { exactRuntimeMatch, executableRuntimeMatch },
      unoptimizedSourceComparison,
      explorerUrl: `https://sepolia.etherscan.io/address/${address}`,
      externalTransactionSent: false,
    };
    break;
  } catch (error) {
    failures.push({ rpcUrl: url, message: error.shortMessage ?? error.message });
  } finally {
    provider?.destroy();
  }
}
if (!result) {
  console.error(JSON.stringify({ address, verified: false, failures }, null, 2));
  process.exitCode = 1;
} else {
  await mkdir(resolve(projectRoot, "artifacts"), { recursive: true });
  await writeFile(resolve(projectRoot, "artifacts/sepolia-verification.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
