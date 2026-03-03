#!/usr/bin/env node
/**
 * Unified PreToolUse hook for context-mode
 * Redirects data-fetching tools to context-mode MCP tools
 *
 * Cross-platform (Windows/macOS/Linux) — no bash/jq dependency.
 */

import { readFileSync, writeFileSync, existsSync, rmSync, cpSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { ROUTING_BLOCK, READ_GUIDANCE, GREP_GUIDANCE } from "./routing-block.mjs";

// Sync write to stdout fd — Windows does not flush console.log before process.exit().
function outputAndExit(data) {
  writeFileSync(1, JSON.stringify(data) + "\n");
  process.exit(0);
}

// ─── Security module: graceful import from compiled build ───
let security = null;
try {
  const __hookDir = dirname(fileURLToPath(import.meta.url));
  security = await import(resolve(__hookDir, "..", "build", "security.js"));
} catch {
  // Build not available — skip security checks, rely on existing routing
}

// ─── Self-heal: rename dir to correct version, fix registry + hooks ───
try {
  const hookDir = dirname(fileURLToPath(import.meta.url));
  const myRoot = resolve(hookDir, "..");
  const myPkg = JSON.parse(readFileSync(resolve(myRoot, "package.json"), "utf-8"));
  const myVersion = myPkg.version ?? "unknown";
  const myDirName = basename(myRoot);
  const cacheParent = dirname(myRoot);
  const marker = resolve(tmpdir(), `context-mode-healed-${myVersion}`);

  if (myVersion !== "unknown" && !existsSync(marker)) {
    // 1. If dir name doesn't match version (e.g. "0.7.0" but code is "0.9.12"),
    //    create correct dir, copy files, update registry + hooks
    const correctDir = resolve(cacheParent, myVersion);
    if (myDirName !== myVersion && !existsSync(correctDir)) {
      cpSync(myRoot, correctDir, { recursive: true });

      // Create start.mjs in new dir if missing
      const startMjs = resolve(correctDir, "start.mjs");
      if (!existsSync(startMjs)) {
        writeFileSync(startMjs, [
          '#!/usr/bin/env node',
          'import { existsSync } from "node:fs";',
          'import { dirname, resolve } from "node:path";',
          'import { fileURLToPath } from "node:url";',
          'const __dirname = dirname(fileURLToPath(import.meta.url));',
          'process.chdir(__dirname);',
          'if (!process.env.CLAUDE_PROJECT_DIR) process.env.CLAUDE_PROJECT_DIR = process.cwd();',
          'if (existsSync(resolve(__dirname, "server.bundle.mjs"))) {',
          '  await import("./server.bundle.mjs");',
          '} else if (existsSync(resolve(__dirname, "build", "server.js"))) {',
          '  await import("./build/server.js");',
          '}',
        ].join("\n"), "utf-8");
      }
    }

    const targetDir = existsSync(correctDir) ? correctDir : myRoot;

    // 2. Update installed_plugins.json → point to correct version dir
    //    Skip if not present (e.g. CI / non-Claude-Code environments)
    const ipPath = resolve(homedir(), ".claude", "plugins", "installed_plugins.json");
    if (existsSync(ipPath)) {
      const ip = JSON.parse(readFileSync(ipPath, "utf-8"));
      for (const [key, entries] of Object.entries(ip.plugins || {})) {
        if (!key.toLowerCase().includes("context-mode")) continue;
        for (const entry of entries) {
          entry.installPath = targetDir;
          entry.version = myVersion;
          entry.lastUpdated = new Date().toISOString();
        }
      }
      writeFileSync(ipPath, JSON.stringify(ip, null, 2) + "\n", "utf-8");
    }

    // 3. Update hook path in settings.json
    const settingsPath = resolve(homedir(), ".claude", "settings.json");
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const hooks = settings.hooks?.PreToolUse;
      if (Array.isArray(hooks)) {
        let changed = false;
        for (const entry of hooks) {
          for (const h of (entry.hooks || [])) {
            if (h.command?.includes("pretooluse.mjs") && !h.command.includes(targetDir)) {
              h.command = "node " + resolve(targetDir, "hooks", "pretooluse.mjs");
              changed = true;
            }
          }
        }
        if (changed) writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      }
    } catch { /* skip settings update */ }

    // 4. Nuke stale version dirs (keep only targetDir and current running dir)
    try {
      const keepDirs = new Set([basename(targetDir), myDirName]);
      for (const d of readdirSync(cacheParent)) {
        if (!keepDirs.has(d)) {
          try { rmSync(resolve(cacheParent, d), { recursive: true, force: true }); } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }

    writeFileSync(marker, Date.now().toString(), "utf-8");
  }
} catch { /* best effort — don't block hook */ }

// Event-based flowing mode avoids two platform bugs:
// - `for await (process.stdin)` hangs on macOS when piped via spawnSync
// - `readFileSync(0)` throws EOF/EISDIR on Windows, EAGAIN on Linux
const raw = await new Promise((resolve, reject) => {
  let data = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => resolve(data));
  process.stdin.on("error", reject);
  process.stdin.resume();
});

const input = JSON.parse(raw);
const tool = input.tool_name ?? "";
const toolInput = input.tool_input ?? {};

// ─── Bash: Stage 1 security check, then Stage 2 routing ───
if (tool === "Bash") {
  const command = toolInput.command ?? "";

  // Stage 1: Security check against user's deny/allow patterns.
  // Only act when an explicit pattern matched. When no pattern matches,
  // evaluateCommand returns { decision: "ask" } with no matchedPattern —
  // in that case fall through so other hooks and Claude Code's native engine can decide.
  if (security) {
    const policies = security.readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
    if (policies.length > 0) {
      const result = security.evaluateCommand(command, policies);
      if (result.decision === "deny") {
        outputAndExit({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            reason: `Blocked by security policy: matches deny pattern ${result.matchedPattern}`,
          },
        });
      }
      if (result.decision === "ask" && result.matchedPattern) {
        outputAndExit({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
          },
        });
      }
      // "allow" or no match → fall through to Stage 2
    }
  }

  // Stage 2: Context-mode routing (existing behavior)

  // curl/wget → replace with echo redirect
  if (/(^|\s|&&|\||\;)(curl|wget)\s/i.test(command)) {
    outputAndExit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          command: 'echo "context-mode: curl/wget blocked. You MUST use mcp__context-mode__fetch_and_index(url, source) to fetch URLs, or mcp__context-mode__execute(language, code) to run HTTP calls in sandbox. Do NOT retry with curl/wget."',
        },
      },
    });
  }

  // inline fetch (node -e, python -c, etc.) → replace with echo redirect
  if (
    /fetch\s*\(\s*['"](https?:\/\/|http)/i.test(command) ||
    /requests\.(get|post|put)\s*\(/i.test(command) ||
    /http\.(get|request)\s*\(/i.test(command)
  ) {
    outputAndExit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          command: 'echo "context-mode: Inline HTTP blocked. Use mcp__context-mode__execute(language, code) to run HTTP calls in sandbox, or mcp__context-mode__fetch_and_index(url, source) for web pages. Do NOT retry with Bash."',
        },
      },
    });
  }

  // allow all other Bash commands
  process.exit(0);
}

// ─── Read: intent-aware nudge ───
// Edit requires file content in context, so Read is the right tool when
// the goal is to modify the file.  For analysis or exploration of large
// files, execute_file keeps raw content out of the context window.
if (tool === "Read") {
  outputAndExit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: READ_GUIDANCE,
    },
  });
}

// ─── Grep: nudge toward execute ───
if (tool === "Grep") {
  outputAndExit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: GREP_GUIDANCE,
    },
  });
}

// ─── WebFetch: deny + redirect to sandbox ───
if (tool === "WebFetch") {
  const url = toolInput.url ?? "";
  outputAndExit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      reason: `context-mode: WebFetch blocked. Use mcp__context-mode__fetch_and_index(url: "${url}", source: "...") to fetch this URL in sandbox. Then use mcp__context-mode__search(queries: [...]) to query results. Do NOT use curl/wget — they are also blocked.`,
    },
  });
}

// ─── Task: inject context-mode routing into subagent prompts ───
if (tool === "Task") {
  const subagentType = toolInput.subagent_type ?? "";
  const prompt = toolInput.prompt ?? "";

  const updatedInput =
    subagentType === "Bash"
      ? { ...toolInput, prompt: prompt + ROUTING_BLOCK, subagent_type: "general-purpose" }
      : { ...toolInput, prompt: prompt + ROUTING_BLOCK };

  outputAndExit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput,
    },
  });
}

// ─── MCP execute: git guard + security check for shell commands ───
if (tool.includes("context-mode") && tool.endsWith("__execute")) {
  // Git commands don't work in the sandbox (no .git directory)
  if (toolInput.language === "shell" && /(^|\s|&&|\||\;)git\s/.test(toolInput.code ?? "")) {
    outputAndExit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        reason: "git commands do not work in the sandbox (no .git directory). Use Bash for all git operations (git log, git diff, git status, etc.).",
      },
    });
  }

  if (security && toolInput.language === "shell") {
    const code = toolInput.code ?? "";
    const policies = security.readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
    if (policies.length > 0) {
      const result = security.evaluateCommand(code, policies);
      if (result.decision === "deny") {
        outputAndExit({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            reason: `Blocked by security policy: shell code matches deny pattern ${result.matchedPattern}`,
          },
        });
      }
      if (result.decision === "ask" && result.matchedPattern) {
        outputAndExit({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
          },
        });
      }
    }
  }
  process.exit(0);
}

// ─── MCP execute_file: check file path + code against deny patterns ───
if (tool.includes("context-mode") && tool.endsWith("__execute_file")) {
  if (security) {
    // Check file path against Read deny patterns
    const filePath = toolInput.path ?? "";
    const denyGlobs = security.readToolDenyPatterns("Read", process.env.CLAUDE_PROJECT_DIR);
    const evalResult = security.evaluateFilePath(filePath, denyGlobs);
    if (evalResult.denied) {
      outputAndExit({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          reason: `Blocked by security policy: file path matches Read deny pattern ${evalResult.matchedPattern}`,
        },
      });
    }

    // Check code parameter against Bash deny patterns (same as execute)
    const lang = toolInput.language ?? "";
    const code = toolInput.code ?? "";
    if (lang === "shell") {
      const policies = security.readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
      if (policies.length > 0) {
        const result = security.evaluateCommand(code, policies);
        if (result.decision === "deny") {
          outputAndExit({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              reason: `Blocked by security policy: shell code matches deny pattern ${result.matchedPattern}`,
            },
          });
        }
        if (result.decision === "ask" && result.matchedPattern) {
          outputAndExit({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "ask",
            },
          });
        }
      }
    }
  }
  process.exit(0);
}

// ─── MCP batch_execute: git guard + security check for each command ───
if (tool.includes("context-mode") && tool.endsWith("__batch_execute")) {
  // Git commands don't work in the sandbox (no .git directory)
  const batchCmds = toolInput.commands ?? [];
  if (batchCmds.some(e => /(^|\s|&&|\||\;)git\s/.test(e.command ?? ""))) {
    outputAndExit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        reason: "git commands do not work in the sandbox (no .git directory). Use Bash for all git operations (git log, git diff, git status, etc.).",
      },
    });
  }

  if (security) {
    const commands = toolInput.commands ?? [];
    const policies = security.readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
    if (policies.length > 0) {
      for (const entry of commands) {
        const cmd = entry.command ?? "";
        const result = security.evaluateCommand(cmd, policies);
        if (result.decision === "deny") {
          outputAndExit({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              reason: `Blocked by security policy: batch command "${entry.label ?? cmd}" matches deny pattern ${result.matchedPattern}`,
            },
          });
        }
        if (result.decision === "ask" && result.matchedPattern) {
          outputAndExit({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "ask",
            },
          });
        }
      }
    }
  }
  process.exit(0);
}

// Unknown tool — pass through
process.exit(0);
