import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// ==============================================================================
// Types
// ==============================================================================

export type PermissionDecision = "allow" | "deny" | "ask";

export interface SecurityPolicy {
  allow: string[];
  deny: string[];
  ask: string[];
}

// ==============================================================================
// Pattern Parsing
// ==============================================================================

/**
 * Extract the glob from a Bash permission pattern.
 * "Bash(sudo *)" returns "sudo *", "Read(.env)" returns null.
 */
export function parseBashPattern(pattern: string): string | null {
  // .+ is greedy: for "Bash(echo (foo))" it captures "echo (foo)"
  // because $ forces the final \) to match only the last paren.
  const match = pattern.match(/^Bash\((.+)\)$/);
  return match ? match[1] : null;
}

// ==============================================================================
// Glob-to-Regex Conversion
// ==============================================================================

/** Escape all regex special characters (including *). */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\\/\-]/g, "\\$&");
}

/** Escape regex specials except *, then convert * to .* */
function convertGlobPart(glob: string): string {
  return glob
    .replace(/[.+?^${}()|[\]\\\/\-]/g, "\\$&")
    .replace(/\*/g, ".*");
}

/**
 * Convert a Bash permission glob to a regex.
 *
 * Two formats:
 * - Colon: "tree:*" becomes /^tree(\s.*)?$/ (command with optional args)
 * - Space: "sudo *" becomes /^sudo .*$/  (literal glob match)
 */
export function globToRegex(
  glob: string,
  caseInsensitive: boolean = false,
): RegExp {
  let regexStr: string;

  const colonIdx = glob.indexOf(":");
  if (colonIdx !== -1) {
    // Colon format: "command:argsGlob"
    const command = glob.slice(0, colonIdx);
    const argsGlob = glob.slice(colonIdx + 1);
    const escapedCmd = escapeRegex(command);
    const argsRegex = convertGlobPart(argsGlob);
    // Match command alone OR command + space + args
    regexStr = `^${escapedCmd}(\\s${argsRegex})?$`;
  } else {
    // Plain glob: "sudo *", "ls*", "* commit *"
    regexStr = `^${convertGlobPart(glob)}$`;
  }

  return new RegExp(regexStr, caseInsensitive ? "i" : "");
}

/**
 * Check if a command matches any Bash pattern in the list.
 * Returns the matching pattern string, or null.
 */
export function matchesAnyPattern(
  command: string,
  patterns: string[],
  caseInsensitive: boolean = false,
): string | null {
  for (const pattern of patterns) {
    const glob = parseBashPattern(pattern);
    if (!glob) continue;
    if (globToRegex(glob, caseInsensitive).test(command)) return pattern;
  }
  return null;
}

// ==============================================================================
// Settings Reader
// ==============================================================================

/** Read one settings file and return a SecurityPolicy with only Bash patterns. */
function readSingleSettings(path: string): SecurityPolicy | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const perms = parsed?.permissions;
  if (!perms || typeof perms !== "object") return null;

  const filterBash = (arr: unknown): string[] => {
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (p): p is string => typeof p === "string" && parseBashPattern(p) !== null,
    );
  };

  return {
    allow: filterBash(perms.allow),
    deny: filterBash(perms.deny),
    ask: filterBash(perms.ask),
  };
}

/**
 * Read Bash permission policies from up to 3 settings files.
 *
 * Returns policies in precedence order (most local first):
 *   1. .claude/settings.local.json  (project-local)
 *   2. .claude/settings.json        (project-shared)
 *   3. ~/.claude/settings.json      (global)
 *
 * Missing or invalid files are silently skipped.
 */
export function readBashPolicies(
  projectDir?: string,
  globalSettingsPath?: string,
): SecurityPolicy[] {
  const policies: SecurityPolicy[] = [];

  if (projectDir) {
    const localPath = resolve(projectDir, ".claude", "settings.local.json");
    const localPolicy = readSingleSettings(localPath);
    if (localPolicy) policies.push(localPolicy);

    const sharedPath = resolve(projectDir, ".claude", "settings.json");
    const sharedPolicy = readSingleSettings(sharedPath);
    if (sharedPolicy) policies.push(sharedPolicy);
  }

  const globalPath =
    globalSettingsPath ?? resolve(homedir(), ".claude", "settings.json");
  const globalPolicy = readSingleSettings(globalPath);
  if (globalPolicy) policies.push(globalPolicy);

  return policies;
}

// ==============================================================================
// Decision Engine
// ==============================================================================

interface CommandDecision {
  decision: PermissionDecision;
  matchedPattern?: string;
}

/**
 * Evaluate a command against policies in precedence order.
 *
 * Within each policy: deny > ask > allow (most restrictive wins).
 * First definitive match across policies wins.
 * Default (no match in any policy): "ask".
 */
export function evaluateCommand(
  command: string,
  policies: SecurityPolicy[],
  caseInsensitive: boolean = process.platform === "win32",
): CommandDecision {
  for (const policy of policies) {
    // Deny takes highest priority within a policy
    const denyMatch = matchesAnyPattern(command, policy.deny, caseInsensitive);
    if (denyMatch) return { decision: "deny", matchedPattern: denyMatch };

    // Ask next
    const askMatch = matchesAnyPattern(command, policy.ask, caseInsensitive);
    if (askMatch) return { decision: "ask", matchedPattern: askMatch };

    // Allow last
    const allowMatch = matchesAnyPattern(
      command,
      policy.allow,
      caseInsensitive,
    );
    if (allowMatch) return { decision: "allow", matchedPattern: allowMatch };
  }

  return { decision: "ask" };
}

/**
 * Server-side variant: only enforce deny patterns.
 *
 * The server has no UI for "ask" prompts, so allow/ask patterns are
 * irrelevant. Returns "deny" if any deny pattern matches, otherwise "allow".
 */
export function evaluateCommandDenyOnly(
  command: string,
  policies: SecurityPolicy[],
  caseInsensitive: boolean = process.platform === "win32",
): { decision: "deny" | "allow"; matchedPattern?: string } {
  for (const policy of policies) {
    const denyMatch = matchesAnyPattern(command, policy.deny, caseInsensitive);
    if (denyMatch) return { decision: "deny", matchedPattern: denyMatch };
  }

  return { decision: "allow" };
}
