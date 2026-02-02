#!/usr/bin/env node

/**
 * Triqual Context MCP Server
 *
 * Local stdio MCP server that exposes a single tool: triqual_load_context.
 * When called, spawns a headless Claude subprocess (Sonnet) that searches
 * Quoth, Exolar, codebase, and Linear to build structured context files
 * at .triqual/context/{feature}/.
 *
 * The subprocess inherits the project's .mcp.json for Quoth/Exolar/Linear access.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

// --- MCP Protocol Constants ---
const JSONRPC_VERSION = "2.0";
const MCP_PROTOCOL_VERSION = "2024-11-05";

const TOOL_DEFINITION = {
  name: "triqual_load_context",
  description:
    "Build comprehensive test context for a feature by spawning a headless Claude subprocess. " +
    "Searches Quoth for patterns/anti-patterns, queries Exolar for failure history, " +
    "scans codebase for relevant files, and optionally fetches Linear ticket details. " +
    "Writes structured, AI-optimized context files to .triqual/context/{feature}/. " +
    "Returns file paths for the main agent to read.",
  inputSchema: {
    type: "object",
    properties: {
      feature: {
        type: "string",
        description:
          'Feature name for context building (e.g., "login", "dashboard", "checkout")',
      },
      ticket: {
        type: "string",
        description:
          'Optional Linear ticket ID (e.g., "ENG-123"). If provided, fetches acceptance criteria.',
      },
      description: {
        type: "string",
        description:
          "Optional text description of what to test. Helps focus the context search.",
      },
      force: {
        type: "boolean",
        description:
          "Regenerate context even if files already exist. Default: false.",
        default: false,
      },
    },
    required: ["feature"],
  },
};

const SUBPROCESS_TIMEOUT_MS = 180_000; // 3 minutes

// --- Project Root Resolution ---

function findProjectRoot(startDir) {
  let dir = startDir || process.cwd();
  const root = path.parse(dir).root;

  while (dir !== root) {
    if (fs.existsSync(path.join(dir, "triqual.config.ts"))) return dir;
    if (fs.existsSync(path.join(dir, ".triqual"))) return dir;
    dir = path.dirname(dir);
  }

  return process.cwd();
}

// --- Config Reading ---

function readTriqualConfig(projectRoot) {
  const configPath = path.join(projectRoot, "triqual.config.ts");
  const config = { testDir: "./tests", baseUrl: "http://localhost:3000" };

  if (!fs.existsSync(configPath)) return config;

  try {
    const content = fs.readFileSync(configPath, "utf-8");

    const testDirMatch = content.match(/testDir:\s*['"]([^'"]+)['"]/);
    if (testDirMatch) config.testDir = testDirMatch[1];

    const baseUrlMatch = content.match(/baseUrl:\s*['"]([^'"]+)['"]/);
    if (baseUrlMatch) config.baseUrl = baseUrlMatch[1];

    const projectIdMatch = content.match(/project_id:\s*['"]([^'"]+)['"]/);
    if (projectIdMatch) config.projectId = projectIdMatch[1];
  } catch {
    // Use defaults
  }

  return config;
}

// --- Prompt Template ---

function loadPromptTemplate(pluginRoot) {
  const templatePath = path.join(
    pluginRoot,
    "mcp",
    "prompts",
    "context-builder.md"
  );
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Prompt template not found: ${templatePath}`);
  }
  return fs.readFileSync(templatePath, "utf-8");
}

function interpolatePrompt(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value || "");
  }
  // Clean up conditional blocks
  result = result.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, varName, content) => {
      return vars[varName] ? content : "";
    }
  );
  return result;
}

// --- Context Validation ---

function contextFilesExist(contextDir) {
  const required = ["patterns.md", "codebase.md"];
  return required.every((f) => fs.existsSync(path.join(contextDir, f)));
}

function contextIsFresh(contextDir, maxAgeMs = 3600_000) {
  // 1 hour default
  try {
    const summaryPath = path.join(contextDir, "summary.md");
    const checkPath = fs.existsSync(summaryPath)
      ? summaryPath
      : path.join(contextDir, "patterns.md");
    if (!fs.existsSync(checkPath)) return false;
    const stat = fs.statSync(checkPath);
    return Date.now() - stat.mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

function listContextFiles(contextDir) {
  if (!fs.existsSync(contextDir)) return [];
  return fs
    .readdirSync(contextDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

// --- Subprocess Spawning ---

function spawnContextBuilder(prompt, projectRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      ["-p", prompt, "--dangerously-skip-permissions", "--model", "sonnet"],
      {
        cwd: projectRoot,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: SUBPROCESS_TIMEOUT_MS,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: undefined },
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Subprocess timed out after ${SUBPROCESS_TIMEOUT_MS / 1000}s`));
    }, SUBPROCESS_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `Subprocess exited with code ${code}. stderr: ${stderr.slice(0, 500)}`
          )
        );
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.stdin.end();
  });
}

// --- Tool Handler ---

async function handleLoadContext({ feature, ticket, description, force }) {
  // Validate feature name to prevent path traversal
  if (
    !feature ||
    feature.includes("..") ||
    feature.includes("/") ||
    feature.includes("\\")
  ) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            message:
              "Invalid feature name. Must not contain path separators or '..'.",
          }),
        },
      ],
      isError: true,
    };
  }

  const projectRoot = findProjectRoot();
  const pluginRoot =
    process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..");
  const config = readTriqualConfig(projectRoot);
  const contextDir = path.join(projectRoot, ".triqual", "context", feature);

  // Check cache
  if (
    !force &&
    contextFilesExist(contextDir) &&
    contextIsFresh(contextDir)
  ) {
    const files = listContextFiles(contextDir);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "cached",
            message: `Context files already exist and are fresh. Use force: true to regenerate.`,
            path: `.triqual/context/${feature}/`,
            files,
          }),
        },
      ],
    };
  }

  // Ensure output directory exists
  fs.mkdirSync(contextDir, { recursive: true });

  // Build prompt
  let template;
  try {
    template = loadPromptTemplate(pluginRoot);
  } catch (err) {
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "error", message: err.message }) }],
      isError: true,
    };
  }

  const prompt = interpolatePrompt(template, {
    feature,
    ticket: ticket || "",
    description: description || "",
    projectRoot,
    testDir: config.testDir,
    baseUrl: config.baseUrl,
    projectId: config.projectId || "",
    contextDir: `.triqual/context/${feature}`,
  });

  // Spawn subprocess
  try {
    await spawnContextBuilder(prompt, projectRoot);
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            message: `Context builder failed: ${err.message}`,
            partialFiles: listContextFiles(contextDir),
          }),
        },
      ],
      isError: true,
    };
  }

  // Validate output
  if (!contextFilesExist(contextDir)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            message:
              "Subprocess completed but required files (patterns.md, codebase.md) were not created.",
            partialFiles: listContextFiles(contextDir),
          }),
        },
      ],
      isError: true,
    };
  }

  const files = listContextFiles(contextDir);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "ok",
          path: `.triqual/context/${feature}/`,
          files,
        }),
      },
    ],
  };
}

// --- MCP Protocol Handler ---

function makeResponse(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function makeError(id, code, message) {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      return makeResponse(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: "triqual-context",
          version: "1.0.0",
        },
      });

    case "notifications/initialized":
      return null; // No response needed

    case "tools/list":
      return makeResponse(id, { tools: [TOOL_DEFINITION] });

    case "tools/call": {
      const { name, arguments: args } = params;
      if (name !== "triqual_load_context") {
        return makeError(id, -32602, `Unknown tool: ${name}`);
      }
      if (!args || !args.feature) {
        return makeError(id, -32602, "Missing required parameter: feature");
      }
      const result = await handleLoadContext(args);
      return makeResponse(id, result);
    }

    case "ping":
      return makeResponse(id, {});

    default:
      if (method?.startsWith("notifications/")) return null;
      return makeError(id, -32601, `Method not found: ${method}`);
  }
}

// --- Stdio Transport ---

function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", async (line) => {
    if (!line.trim()) return;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      const err = makeError(null, -32700, "Parse error");
      process.stdout.write(JSON.stringify(err) + "\n");
      return;
    }

    const response = await handleMessage(msg);
    if (response) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

main();
