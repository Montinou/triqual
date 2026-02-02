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
    "Build test context for a feature. Automatically analyzes feature complexity and optimizes " +
    "context depth (fast local scan for simple features, full Quoth/Exolar search for complex ones). " +
    "Writes structured context files to .triqual/context/{feature}/.",
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
          'Optional Linear ticket ID (e.g., "ENG-123"). Fetches acceptance criteria and requirements.',
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
      level: {
        type: "string",
        enum: ["light", "standard", "full", "auto"],
        default: "auto",
        description:
          "Advanced: Override automatic level detection. Usually not needed.",
      },
    },
    required: ["feature"],
  },
};

const EXTEND_TOOL_DEFINITION = {
  name: "triqual_extend_context",
  description:
    "Advanced: Add specific context files to existing context. Rarely needed since " +
    "triqual_load_context auto-detects appropriate depth. Use only if you specifically " +
    "need additional files after context was already loaded.",
  inputSchema: {
    type: "object",
    properties: {
      feature: {
        type: "string",
        description: "Feature name with existing context",
      },
      add: {
        type: "array",
        items: {
          type: "string",
          enum: ["anti-patterns", "failures", "requirements"],
        },
        description: "Additional files to generate",
      },
      ticket: {
        type: "string",
        description: "Required if adding requirements",
      },
    },
    required: ["feature", "add"],
  },
};

const SUBPROCESS_TIMEOUT_MS = 600_000; // 10 minutes (all modes)
const STANDARD_TIMEOUT_MS = 600_000;   // 10 minutes (same as full)
const LIGHT_CONTEXT_FRESHNESS_MS = 1800_000; // 30 minutes for light context

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

function loadPromptTemplate(pluginRoot, templateName = "context-builder.md") {
  const templatePath = path.join(
    pluginRoot,
    "mcp",
    "prompts",
    templateName
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

// --- Level Detection ---

function hasSuccessfulRunLog(feature, projectRoot) {
  const runLogPath = path.join(projectRoot, ".triqual", "runs", `${feature}.md`);
  if (!fs.existsSync(runLogPath)) return false;

  try {
    const content = fs.readFileSync(runLogPath, "utf-8");
    // Check for LEARN stage (only written after tests pass)
    return /^#{2,3} Stage: LEARN/m.test(content);
  } catch {
    return false;
  }
}

function hasFailedRunLog(feature, projectRoot) {
  const runLogPath = path.join(projectRoot, ".triqual", "runs", `${feature}.md`);
  if (!fs.existsSync(runLogPath)) return false;

  try {
    const content = fs.readFileSync(runLogPath, "utf-8");
    // Check for multiple failed attempts (suggests complexity)
    const failCount = (content.match(/Result:\s*FAILED/gi) || []).length;
    return failCount >= 3;
  } catch {
    return false;
  }
}

function hasExistingTests(feature, projectRoot, testDir) {
  const fullTestDir = path.join(projectRoot, testDir);
  if (!fs.existsSync(fullTestDir)) return false;

  try {
    const { execSync } = require("child_process");
    const result = execSync(
      `find "${fullTestDir}" -name "*${feature}*.spec.ts" -o -name "*${feature}*.test.ts" 2>/dev/null | head -1`,
      { encoding: "utf-8" }
    ).trim();
    return result.length > 0;
  } catch {
    return false;
  }
}

function isComplexFeature(feature) {
  // Complex feature patterns that benefit from full context
  const complexPatterns = [
    /auth/i, /login/i, /signup/i, /register/i,
    /checkout/i, /payment/i, /billing/i,
    /dashboard/i, /admin/i,
    /workflow/i, /wizard/i, /multi.?step/i,
    /upload/i, /import/i, /export/i,
    /search/i, /filter/i,
    /notification/i, /email/i,
    /integration/i, /api/i, /webhook/i,
  ];

  return complexPatterns.some((pattern) => pattern.test(feature));
}

function isSimpleFeature(feature) {
  // Simple feature patterns that work well with light context
  const simplePatterns = [
    /^button$/i, /^link$/i, /^modal$/i, /^tooltip$/i,
    /^header$/i, /^footer$/i, /^nav/i,
    /^badge$/i, /^tag$/i, /^chip$/i,
    /^spinner$/i, /^loader$/i,
  ];

  return simplePatterns.some((pattern) => pattern.test(feature));
}

function detectLevel(args, projectRoot) {
  // Explicit level overrides auto-detection
  if (args.level && args.level !== "auto") {
    return args.level;
  }

  const config = readTriqualConfig(projectRoot);
  const feature = args.feature;

  // FULL LEVEL TRIGGERS:

  // 1. Ticket provided - always full (needs requirements, AC)
  if (args.ticket) {
    return "full";
  }

  // 2. Long description (>100 chars) - suggests complex requirements
  if (args.description && args.description.length > 100) {
    return "full";
  }

  // 3. Previous failures on this feature - need more context to debug
  if (hasFailedRunLog(feature, projectRoot)) {
    return "full";
  }

  // 4. Known complex feature pattern
  if (isComplexFeature(feature)) {
    return "standard"; // Use standard, can upgrade to full if needed
  }

  // LIGHT LEVEL TRIGGERS:

  // 1. Feature has successful run log (iterations on working tests)
  if (hasSuccessfulRunLog(feature, projectRoot)) {
    return "light";
  }

  // 2. Simple feature pattern AND existing tests exist
  if (isSimpleFeature(feature) && hasExistingTests(feature, projectRoot, config.testDir)) {
    return "light";
  }

  // STANDARD: Default for new test generation
  return "standard";
}

function getContextLevel(contextDir) {
  const summaryPath = path.join(contextDir, "summary.md");
  if (!fs.existsSync(summaryPath)) return null;

  try {
    const content = fs.readFileSync(summaryPath, "utf-8");
    const match = content.match(/^Level:\s*(\w+)/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// --- Context Validation ---

function contextFilesExist(contextDir, level = "standard") {
  const levelFiles = {
    light: ["codebase.md"],
    standard: ["patterns.md", "codebase.md"],
    full: ["patterns.md", "codebase.md", "existing-tests.md"],
  };
  const required = levelFiles[level] || levelFiles.standard;
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

// --- Light Mode (Local Scan) ---

const { execSync } = require("child_process");

function scanCodebaseLocal(feature, projectRoot, testDir) {
  const results = {
    sourceFiles: [],
    selectors: [],
    routes: [],
    components: [],
  };

  // Search patterns in common source directories
  const searchDirs = ["src", "app", "pages", "components", "lib"].filter((d) =>
    fs.existsSync(path.join(projectRoot, d))
  );

  for (const dir of searchDirs) {
    try {
      // Search for feature name in files (case-insensitive)
      const grepResult = execSync(
        `grep -rniI "${feature}" "${path.join(projectRoot, dir)}" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" 2>/dev/null | head -20`,
        { encoding: "utf-8", maxBuffer: 1024 * 1024 }
      ).trim();

      if (grepResult) {
        const lines = grepResult.split("\n").filter(Boolean);
        for (const line of lines) {
          const match = line.match(/^([^:]+):(\d+):/);
          if (match) {
            results.sourceFiles.push({
              path: match[1].replace(projectRoot + "/", ""),
              line: match[2],
            });
          }
        }
      }
    } catch {
      // grep returns non-zero if no matches
    }
  }

  // Extract data-testid selectors
  for (const dir of searchDirs) {
    try {
      const testidResult = execSync(
        `grep -rohE 'data-testid="[^"]+"' "${path.join(projectRoot, dir)}" 2>/dev/null | sort -u | head -30`,
        { encoding: "utf-8", maxBuffer: 1024 * 1024 }
      ).trim();

      if (testidResult) {
        results.selectors.push(
          ...testidResult.split("\n").filter((s) => s.includes(feature.toLowerCase()))
        );
      }
    } catch {
      // no matches
    }
  }

  return results;
}

function findExistingTestsLocal(feature, projectRoot, testDir) {
  const results = {
    testFiles: [],
    pageObjects: [],
    helpers: [],
  };

  const fullTestDir = path.join(projectRoot, testDir);

  // Find test files
  if (fs.existsSync(fullTestDir)) {
    try {
      const testFiles = execSync(
        `find "${fullTestDir}" -name "*.spec.ts" -o -name "*.test.ts" 2>/dev/null | head -20`,
        { encoding: "utf-8" }
      ).trim();

      if (testFiles) {
        results.testFiles = testFiles.split("\n").filter(Boolean).map((f) => f.replace(projectRoot + "/", ""));
      }
    } catch {
      // no matches
    }

    // Find page objects
    try {
      const pageObjects = execSync(
        `find "${fullTestDir}" -name "*Page.ts" -o -name "*page.ts" 2>/dev/null`,
        { encoding: "utf-8" }
      ).trim();

      if (pageObjects) {
        results.pageObjects = pageObjects.split("\n").filter(Boolean).map((f) => f.replace(projectRoot + "/", ""));
      }
    } catch {
      // no matches
    }

    // Find helpers/fixtures
    try {
      const helpers = execSync(
        `find "${fullTestDir}" -name "*helper*.ts" -o -name "*fixture*.ts" -o -name "seed*.ts" 2>/dev/null`,
        { encoding: "utf-8" }
      ).trim();

      if (helpers) {
        results.helpers = helpers.split("\n").filter(Boolean).map((f) => f.replace(projectRoot + "/", ""));
      }
    } catch {
      // no matches
    }
  }

  return results;
}

async function buildLightContext(feature, projectRoot, contextDir, config) {
  // Ensure output directory exists
  fs.mkdirSync(contextDir, { recursive: true });

  // 1. Scan codebase locally
  const codebase = scanCodebaseLocal(feature, projectRoot, config.testDir);

  // 2. Find existing tests locally
  const tests = findExistingTestsLocal(feature, projectRoot, config.testDir);

  // 3. Write codebase.md
  const codebaseContent = `# Codebase: ${feature}

## Source Files
${codebase.sourceFiles.length > 0
    ? codebase.sourceFiles.map((f) => `- ${f.path}:${f.line}`).join("\n")
    : "- No source files found matching feature name"}

## Selectors Found
${codebase.selectors.length > 0
    ? codebase.selectors.map((s) => `- ${s}`).join("\n")
    : "- No data-testid selectors found matching feature"}

## Existing Tests
${tests.testFiles.length > 0
    ? tests.testFiles.map((f) => `- ${f}`).join("\n")
    : "- No existing test files found"}

## Page Objects Available
${tests.pageObjects.length > 0
    ? tests.pageObjects.map((f) => `- ${f}`).join("\n")
    : "- No page objects found"}

## Helpers/Fixtures
${tests.helpers.length > 0
    ? tests.helpers.map((f) => `- ${f}`).join("\n")
    : "- No helpers/fixtures found"}
`;

  fs.writeFileSync(path.join(contextDir, "codebase.md"), codebaseContent);

  // 4. Write summary.md
  const summaryContent = `# Context Summary: ${feature}

Level: light
Generated: ${new Date().toISOString()}
Feature: ${feature}

## Files
| File | Content |
|------|---------|
| codebase.md | Local codebase scan |

## Note
This is a **light** context (local scan only). No Quoth patterns or Exolar data.

To upgrade context, use:
- \`triqual_load_context({ feature: "${feature}", level: "standard" })\` - Add Quoth patterns
- \`triqual_load_context({ feature: "${feature}", level: "full" })\` - Full context with all sources
- \`triqual_extend_context({ feature: "${feature}", add: ["failures"] })\` - Add specific files
`;

  fs.writeFileSync(path.join(contextDir, "summary.md"), summaryContent);

  return {
    files: ["codebase.md", "summary.md"],
    level: "light",
    sourceFiles: codebase.sourceFiles.length,
    selectors: codebase.selectors.length,
    testFiles: tests.testFiles.length,
  };
}

// --- Subprocess Spawning ---

function spawnContextBuilder(prompt, projectRoot, timeoutMs = SUBPROCESS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      ["-p", prompt, "--dangerously-skip-permissions", "--model", "sonnet"],
      {
        cwd: projectRoot,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: timeoutMs,
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
      reject(new Error(`Subprocess timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

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

async function handleLoadContext({ feature, level, ticket, description, force }) {
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

  // Auto-detect level if not specified or "auto"
  const detectedLevel = detectLevel({ feature, level, ticket, description }, projectRoot);
  const freshnessMs = detectedLevel === "light" ? LIGHT_CONTEXT_FRESHNESS_MS : 3600_000;

  // Check cache (level-aware)
  if (
    !force &&
    contextFilesExist(contextDir, detectedLevel) &&
    contextIsFresh(contextDir, freshnessMs)
  ) {
    const files = listContextFiles(contextDir);
    const currentLevel = getContextLevel(contextDir) || detectedLevel;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "cached",
            level: currentLevel,
            message: `Context files already exist and are fresh (level: ${currentLevel}). Use force: true to regenerate.`,
            path: `.triqual/context/${feature}/`,
            files,
          }),
        },
      ],
    };
  }

  // Ensure output directory exists
  fs.mkdirSync(contextDir, { recursive: true });

  // LIGHT MODE: Local scan only (no subprocess)
  if (detectedLevel === "light") {
    try {
      const result = await buildLightContext(feature, projectRoot, contextDir, config);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              level: "light",
              path: `.triqual/context/${feature}/`,
              files: result.files,
              stats: {
                sourceFiles: result.sourceFiles,
                selectors: result.selectors,
                testFiles: result.testFiles,
              },
              note: "Light context generated (local scan only). Use level: 'standard' or 'full' for Quoth patterns.",
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              message: `Light context build failed: ${err.message}`,
            }),
          },
        ],
        isError: true,
      };
    }
  }

  // STANDARD/FULL MODE: Subprocess required
  const templateName = detectedLevel === "full" ? "context-full.md" : "context-standard.md";
  const timeoutMs = detectedLevel === "full" ? SUBPROCESS_TIMEOUT_MS : STANDARD_TIMEOUT_MS;

  let template;
  try {
    template = loadPromptTemplate(pluginRoot, templateName);
  } catch (err) {
    // Fall back to context-builder.md if specific template doesn't exist
    try {
      template = loadPromptTemplate(pluginRoot, "context-builder.md");
    } catch (fallbackErr) {
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "error", message: err.message }) }],
        isError: true,
      };
    }
  }

  const prompt = interpolatePrompt(template, {
    feature,
    level: detectedLevel,
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
    await spawnContextBuilder(prompt, projectRoot, timeoutMs);
  } catch (err) {
    const partialFiles = listContextFiles(contextDir);
    const isTimeout = err.message.includes("timed out");

    // If we have partial files from a timeout, treat as partial success
    if (isTimeout && partialFiles.length > 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "partial",
              level: detectedLevel,
              message: `Context builder timed out but produced ${partialFiles.length} file(s). These can still be used.`,
              path: `.triqual/context/${feature}/`,
              files: partialFiles,
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            level: detectedLevel,
            message: `Context builder failed: ${err.message}`,
            partialFiles,
          }),
        },
      ],
      isError: true,
    };
  }

  // Validate output (level-aware)
  if (!contextFilesExist(contextDir, detectedLevel)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            level: detectedLevel,
            message:
              `Subprocess completed but required files for level '${detectedLevel}' were not created.`,
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
          level: detectedLevel,
          path: `.triqual/context/${feature}/`,
          files,
        }),
      },
    ],
  };
}

// --- Extend Context Handler ---

async function handleExtendContext({ feature, add, ticket }) {
  // Validate feature name
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
            message: "Invalid feature name.",
          }),
        },
      ],
      isError: true,
    };
  }

  if (!add || add.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            message: "Must specify at least one file type to add.",
          }),
        },
      ],
      isError: true,
    };
  }

  // Check requirements needs ticket
  if (add.includes("requirements") && !ticket) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            message: "Adding requirements requires a ticket ID.",
          }),
        },
      ],
      isError: true,
    };
  }

  const projectRoot = findProjectRoot();
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..");
  const config = readTriqualConfig(projectRoot);
  const contextDir = path.join(projectRoot, ".triqual", "context", feature);

  // Verify context exists
  if (!fs.existsSync(contextDir)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            message: `No existing context for '${feature}'. Use triqual_load_context first.`,
          }),
        },
      ],
      isError: true,
    };
  }

  // Build a targeted prompt for just the requested files
  const addPrompt = `You are extending existing test context for feature: **${feature}**

Project root: ${projectRoot}
Test directory: ${config.testDir}
Context directory: .triqual/context/${feature}

## Task

Generate ONLY the following additional files:

${add.includes("anti-patterns") ? `
### anti-patterns.md
Search Quoth for anti-patterns:
quoth_search_index({ query: "${feature} test failures anti-patterns" })

Extract from search snippets (prefer snippets over full doc reads).
Write .triqual/context/${feature}/anti-patterns.md
` : ""}

${add.includes("failures") ? `
### failures.md
Query Exolar for failure history:
query_exolar_data({ dataset: "test_search", filters: { search: "${feature}" }})
query_exolar_data({ dataset: "failure_patterns", filters: { search: "${feature}" }})

Write .triqual/context/${feature}/failures.md
` : ""}

${add.includes("requirements") && ticket ? `
### requirements.md
Fetch Linear ticket:
mcp__linear__get_issue({ id: "${ticket}" })

Extract acceptance criteria.
Write .triqual/context/${feature}/requirements.md
` : ""}

## Rules
- ONLY write the requested files
- Do NOT modify existing files
- Do NOT write test code
`;

  try {
    await spawnContextBuilder(addPrompt, projectRoot, STANDARD_TIMEOUT_MS);
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            message: `Extend context failed: ${err.message}`,
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
          message: `Added ${add.join(", ")} to context`,
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
      return makeResponse(id, { tools: [TOOL_DEFINITION, EXTEND_TOOL_DEFINITION] });

    case "tools/call": {
      const { name, arguments: args } = params;

      if (name === "triqual_load_context") {
        if (!args || !args.feature) {
          return makeError(id, -32602, "Missing required parameter: feature");
        }
        const result = await handleLoadContext(args);
        return makeResponse(id, result);
      }

      if (name === "triqual_extend_context") {
        if (!args || !args.feature) {
          return makeError(id, -32602, "Missing required parameter: feature");
        }
        if (!args.add || args.add.length === 0) {
          return makeError(id, -32602, "Missing required parameter: add (array of file types)");
        }
        const result = await handleExtendContext(args);
        return makeResponse(id, result);
      }

      return makeError(id, -32602, `Unknown tool: ${name}`);
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
