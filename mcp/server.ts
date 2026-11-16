// stdio MCP server for AIPanel. Register with:
//   claude mcp add --scope user aipanel -- <node> <repo>/node_modules/.bin/tsx <repo>/mcp/server.ts
// stdout is the MCP channel: everything else must go to stderr.
import fs from "node:fs";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDebateStore } from "../lib/debate-store";
import { getRegistry } from "../lib/providers/registry";
import { createAipanelServer } from "./tools";

const repoRoot = path.resolve(__dirname, "..");

// Same configuration as the web app, whatever cwd Claude Code starts us in:
// the repo's .env.local (OpenRouter key, CLI paths) and its data dir.
const envFile = path.join(repoRoot, ".env.local");
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
process.env.AIPANEL_DATA_DIR ||= path.join(repoRoot, "data");

// Library code logs progress with console.log; keep it off the protocol stream.
console.log = (...args: unknown[]) => console.error(...args);

async function main() {
  const server = createAipanelServer({
    store: getDebateStore(),
    registry: getRegistry(),
    apiKey: process.env.OPENROUTER_API_KEY?.trim() || undefined,
  });
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("[aipanel-mcp] failed to start:", err);
  process.exit(1);
});
