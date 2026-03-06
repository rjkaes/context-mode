/**
 * Tests for cli.bundle.mjs — ensures CLI works for marketplace installs
 * where build/ directory doesn't exist.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, accessSync, constants } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

describe("cli.bundle.mjs — marketplace install support", () => {
  // ── Package configuration ─────────────────────────────────

  it("package.json files field includes cli.bundle.mjs", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    expect(pkg.files).toContain("cli.bundle.mjs");
  });

  it("package.json bundle script builds cli.bundle.mjs", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    expect(pkg.scripts.bundle).toContain("cli.bundle.mjs");
    expect(pkg.scripts.bundle).toContain("src/cli.ts");
  });

  // ── Bundle artifact ────────────────────────────────────────

  it("cli.bundle.mjs exists after npm run bundle", () => {
    expect(existsSync(resolve(ROOT, "cli.bundle.mjs"))).toBe(true);
  });

  it("cli.bundle.mjs is readable", () => {
    expect(() => accessSync(resolve(ROOT, "cli.bundle.mjs"), constants.R_OK)).not.toThrow();
  });

  it("cli.bundle.mjs has shebang only on line 1 (Node.js strips it)", () => {
    const content = readFileSync(resolve(ROOT, "cli.bundle.mjs"), "utf-8");
    const lines = content.split("\n");
    expect(lines[0].startsWith("#!")).toBe(true);
    // No shebang on any other line (would cause SyntaxError)
    const shebangsAfterLine1 = lines.slice(1).filter(l => l.startsWith("#!"));
    expect(shebangsAfterLine1).toHaveLength(0);
  });

  // ── Source code contracts ──────────────────────────────────

  it("cli.ts getPluginRoot handles both build/ and root locations", () => {
    const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
    // Must detect build/ subdirectory and go up, or stay at root
    expect(src).toContain('endsWith("/build")');
    expect(src).toContain('endsWith("\\\\build")');
  });

  it("cli.ts upgrade copies cli.bundle.mjs to target", () => {
    const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
    expect(src).toContain('"cli.bundle.mjs"');
    // Must be in the items array for in-place update
    expect(src).toMatch(/items\s*=\s*\[[\s\S]*?"cli\.bundle\.mjs"/);
  });

  it("cli.ts upgrade doctor call prefers cli.bundle.mjs with fallback", () => {
    const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
    expect(src).toContain("cli.bundle.mjs");
    expect(src).toContain("build", "cli.js");
    // Must use existsSync for fallback
    expect(src).toContain("existsSync");
  });

  it("cli.ts upgrade chmod handles both cli binaries", () => {
    const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
    // Must chmod both build/cli.js and cli.bundle.mjs
    expect(src).toMatch(/for\s*\(.*\["build\/cli\.js",\s*"cli\.bundle\.mjs"\]/);
  });

  // ── Skill files ────────────────────────────────────────────

  it("ctx-upgrade skill uses cli.bundle.mjs with fallback", () => {
    const skill = readFileSync(resolve(ROOT, "skills", "ctx-upgrade", "SKILL.md"), "utf-8");
    expect(skill).toContain("cli.bundle.mjs");
    expect(skill).toContain("build/cli.js");
    // Fallback pattern: try bundle first, then build
    expect(skill).toMatch(/CLI=.*cli\.bundle\.mjs.*\[ ! -f.*\].*build\/cli\.js/);
  });

  it("ctx-doctor skill uses cli.bundle.mjs with fallback", () => {
    const skill = readFileSync(resolve(ROOT, "skills", "ctx-doctor", "SKILL.md"), "utf-8");
    expect(skill).toContain("cli.bundle.mjs");
    expect(skill).toContain("build/cli.js");
    expect(skill).toMatch(/CLI=.*cli\.bundle\.mjs.*\[ ! -f.*\].*build\/cli\.js/);
  });

  // ── .gitignore ─────────────────────────────────────────────

  it(".gitignore does not exclude cli.bundle.mjs", () => {
    const gitignore = readFileSync(resolve(ROOT, ".gitignore"), "utf-8");
    // cli.bundle.mjs must NOT be in gitignore patterns
    expect(gitignore).not.toContain("cli.bundle.mjs\n");
    // But should have a comment documenting it's committed
    expect(gitignore).toContain("cli.bundle.mjs is committed");
  });
});
