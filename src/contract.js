import { isAddress, ZeroAddress } from "ethers";

export const TICKET_ABI = [
  "function mint() returns (uint256 tokenId)",
  "function hasMinted(address account) view returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Mint(address indexed minter, uint256 indexed tokenId)",
];

const networks = {
  "11155111": {
    chainId: "0xaa36a7",
    chainName: "Sepolia",
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    explorerUrl: "https://sepolia.etherscan.io",
  },
  "31337": {
    chainId: "0x7a69",
    chainName: "Local Hardhat",
    rpcUrl: "http://127.0.0.1:8545",
    explorerUrl: "",
  },
};

export function createContractConfig(env = import.meta.env) {
  const address = (env.VITE_CONTRACT_ADDRESS ?? "").trim();
  const network = networks[String(env.VITE_CHAIN_ID || "11155111")];
  let error = "";
  if (!network) {
    error = "Unsupported VITE_CHAIN_ID. Use 11155111 for Sepolia or 31337 for the local chain.";
  } else if (!isAddress(address) || address.toLowerCase() === ZeroAddress) {
    error = "Setup needed: put the deployed TicketNFT address in .env as VITE_CONTRACT_ADDRESS, then restart Vite.";
  }
  return { address, abi: TICKET_ABI, network, error };
}

export const CONTRACT_CONFIG = createContractConfig();
