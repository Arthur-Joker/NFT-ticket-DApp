import { defineConfig } from "hardhat/config";

// Hardhat supplies only the local EVM. Compilation uses the pinned solc npm
// package so no compiler download is needed after npm ci.
export default defineConfig({
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 31337,
    },
  },
});
