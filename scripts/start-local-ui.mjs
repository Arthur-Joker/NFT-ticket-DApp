import { readFile } from "node:fs/promises";
import { isAddress } from "ethers";

// Public settings only. This does not create or overwrite a user's Sepolia .env.
let deployment;
try {
  deployment = JSON.parse(await readFile(new URL("../deployments/localhost.json", import.meta.url), "utf8"));
} catch {
  throw new Error("Run npm run chain, then npm run deploy:local before starting the local UI.");
}
if (deployment.chainId !== 31337 || !isAddress(deployment.address)) {
  throw new Error("The local deployment record is invalid. Run npm run deploy:local again.");
}
process.env.VITE_CHAIN_ID = "31337";
process.env.VITE_CONTRACT_ADDRESS = deployment.address;
const { createServer } = await import("vite");
const server = await createServer({ server: { host: "127.0.0.1", port: 5173, strictPort: true } });
await server.listen();
server.printUrls();
console.log(`Local TicketNFT: ${deployment.address}. This mode does not change .env.`);
