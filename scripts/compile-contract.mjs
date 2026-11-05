import { readFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, sep } from "node:path";
import solc from "solc";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function compileContracts({ includeFixtures = false, writeArtifacts = true } = {}) {
  if (!solc.version().startsWith("0.8.30+")) {
    throw new Error("This project requires solc 0.8.30. Run npm ci.");
  }
  const ozPackage = JSON.parse(await readFile(resolve(projectRoot, "node_modules/@openzeppelin/contracts/package.json"), "utf8"));
  if (ozPackage.version !== "5.6.1") {
    throw new Error("This project requires @openzeppelin/contracts 5.6.1. Run npm ci.");
  }

  const sourceNames = ["contracts/TicketNFT.sol"];
  if (includeFixtures) sourceNames.push("test/contracts/Receivers.sol");
  const sources = Object.fromEntries(await Promise.all(sourceNames.map(async (name) => [
    name, { content: await readFile(resolve(projectRoot, name), "utf8") },
  ])));

  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), {
    import(importPath) {
      const normalized = importPath.replace(/^@openzeppelin\/contracts@5\.6\.1\//, "@openzeppelin/contracts/");
      const packageRoot = resolve(projectRoot, "node_modules/@openzeppelin/contracts");
      const resolved = resolve(projectRoot, "node_modules", normalized);
      if (!resolved.startsWith(packageRoot + sep)) return { error: `Unsupported import: ${importPath}` };
      try { return { contents: readFileSync(resolved, "utf8") }; }
      catch { return { error: `Import not found: ${importPath}. Run npm ci.` }; }
    },
  }));
  const errors = (output.errors ?? []).filter((entry) => entry.severity === "error");
  if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));

  const contracts = {};
  for (const sourceName of sourceNames) {
    for (const [contractName, compiled] of Object.entries(output.contracts[sourceName])) {
      contracts[contractName] = {
        contractName, sourceName, compilerVersion: solc.version(),
        abi: compiled.abi,
        bytecode: `0x${compiled.evm.bytecode.object}`,
        deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
      };
    }
  }
  if (writeArtifacts) {
    await mkdir(resolve(projectRoot, "artifacts"), { recursive: true });
    await writeFile(resolve(projectRoot, "artifacts/TicketNFT.json"), JSON.stringify(contracts.TicketNFT, null, 2) + "\n");
  }
  return contracts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await compileContracts();
  console.log("TicketNFT compiled with solc 0.8.30 and OpenZeppelin 5.6.1 → artifacts/TicketNFT.json");
}
