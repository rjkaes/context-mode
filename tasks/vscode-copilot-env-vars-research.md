# VS Code Copilot Agent Mode: Environment Variables Research

## Summary

**There is no dedicated env var to detect "VS Code with Copilot agent mode."** This is a confirmed gap. A feature request ([microsoft/vscode#265446](https://github.com/microsoft/vscode/issues/265446)) was filed and closed as duplicate, meaning the VS Code team is aware but has not shipped it yet.

---

## 1. VSCODE_* Environment Variables in Process Tree

VS Code sets these env vars in child processes (terminals, extension host, spawned servers):

| Variable | Context | Notes |
|---|---|---|
| `TERM_PROGRAM=vscode` | Integrated terminal | Best way to detect "running inside VS Code terminal" |
| `VSCODE_IPC_HOOK_CLI` | Terminal / child processes | Socket path for `code` CLI IPC |
| `VSCODE_GIT_IPC_HANDLE` | Terminal / child processes | Git credential forwarding |
| `VSCODE_GIT_ASKPASS_NODE` | Terminal | Node binary for git askpass |
| `VSCODE_GIT_ASKPASS_MAIN` | Terminal | Askpass script path |
| `VSCODE_GIT_ASKPASS_EXTRA_ARGS` | Terminal | Extra args for askpass |
| `VSCODE_INJECTION` | Terminal | Set to `1` when VS Code injects into shell |
| `VSCODE_RESOLVING_ENVIRONMENT` | Shell init | Set to `1` during environment resolution |
| `VSCODE_PID` | Extension host | VS Code main process PID |
| `VSCODE_CWD` | Extension host / server | Working directory |
| `VSCODE_NLS_CONFIG` | Extension host | Localization config JSON |
| `VSCODE_CLI` | Extension host | Set to `1` in CLI context |
| `VSCODE_HANDLES_UNCAUGHT_ERRORS` | Extension host | Set to `true` |
| `ELECTRON_RUN_AS_NODE` | Extension host / child | Set to `1` by Electron |
| `VSCODE_AMD_ENTRYPOINT` | Extension host | Module entry point |
| `VSCODE_CRASH_REPORTER_PROCESS_TYPE` | Extension host | Crash reporter context |
| `VSCODE_CODE_CACHE_PATH` | Extension host | Code cache dir |

**For MCP stdio servers**: VS Code spawns them as child processes from the extension host. They inherit the extension host's environment merged with any `env` block from `mcp.json`. The inherited vars include `ELECTRON_RUN_AS_NODE`, `VSCODE_*` vars from the extension host, plus the user's base environment.

---

## 2. GITHUB_COPILOT_AGENT / COPILOT_SESSION_ID: Do They Exist?

**No.** Neither `GITHUB_COPILOT_AGENT` nor `COPILOT_SESSION_ID` is a real environment variable set by VS Code or the Copilot extension.

- The Copilot extension (github.copilot, github.copilot-chat) does not export any `COPILOT_*` or `GITHUB_COPILOT_*` env vars into terminals or child processes.
- The `sessionId` exists as an internal API parameter in the Copilot SDK (`SessionConfig.sessionId`), but it is NOT exposed as an environment variable.
- The only Copilot-related env var is `GH_TOKEN`, which the copilot-chat extension sets in the terminal PATH for `copilot` CLI auth.

---

## 3. Environment Variables Available to MCP Servers Inside VS Code

MCP servers (stdio type) receive:

1. **User's base environment** (inherited from the shell that launched VS Code)
2. **Extension host VSCODE_* vars** (listed in section 1)
3. **Explicit `env` from mcp.json** (user-configured per-server overrides)
4. **`envFile` contents** if specified in mcp.json

There is **no** VS Code-injected variable that says "you are being called from Copilot agent mode" vs. "you are being called from Copilot chat" vs. "you are being called from a non-Copilot extension."

---

## 4. How to Distinguish "VS Code with Copilot" from "Plain VS Code"

**Currently impossible via env vars alone.** Here is what you can do:

| Method | Detects | Limitation |
|---|---|---|
| `TERM_PROGRAM === 'vscode'` | Running in VS Code terminal | Does not distinguish Copilot vs. manual |
| `VSCODE_IPC_HOOK_CLI` exists | Running as VS Code child process | Does not distinguish Copilot vs. manual |
| `VSCODE_INJECTION === '1'` | VS Code shell integration active | Affects ALL terminals, not just AI ones |
| Check `~/.vscode/extensions/` for `github.copilot-*` | Copilot extension installed | Does not mean Copilot is *active* |
| Feature request [#265446](https://github.com/microsoft/vscode/issues/265446) | Proposed `VSCODE_COPILOT_TERMINAL=1` | Closed as duplicate; not yet implemented |

The feature request proposed `VSCODE_COPILOT_TERMINAL=1` or `COPILOT_TERMINAL=1` or `VSCODE_ASSISTANT_SESSION=1`, but it was closed as a duplicate of an internal/existing tracking issue. This means the VS Code team acknowledges the need but hasn't shipped a solution.

---

## 5. Config Directories

### VS Code
| Path | Purpose |
|---|---|
| `~/.vscode/extensions/` | Installed extensions (including `github.copilot-*`) |
| `~/.vscode/argv.json` | CLI arguments / locale |
| `~/Library/Application Support/Code/User/` (macOS) | User settings, keybindings |
| `~/.config/Code/User/` (Linux) | User settings, keybindings |
| `.vscode/mcp.json` | Workspace MCP server config |
| `~/.vscode/mcp.json` or profile-scoped | User-level MCP server config |

### GitHub Copilot Extension
| Path | Purpose |
|---|---|
| `~/.config/github-copilot/` | Copilot extension telemetry/auth cache (legacy) |
| `~/.config/github-copilot/hosts.json` | OAuth token cache (legacy, pre-GH CLI auth) |
| VS Code settings (`github.copilot.*`) | Copilot extension settings (stored in VS Code user settings) |

### GitHub Copilot CLI (separate product)
| Path | Purpose |
|---|---|
| `~/.copilot/` | Main config dir |
| `~/.copilot/config.json` | CLI settings |
| `~/.copilot/mcp-config.json` | MCP server configs |
| `~/.copilot/agents/` | Custom agent definitions |
| `~/.copilot/session-state/` | Session data |
| `~/.config/gh/hosts.yml` | GH CLI auth tokens (shared) |
| `$XDG_CONFIG_HOME/copilot/` | Alternate location if XDG set |

### Copilot Coding Agent (GitHub cloud)
- Uses `COPILOT_MCP_*` prefixed env vars from repository environment settings
- These are **only** available in the GitHub-hosted agent runner, not in VS Code

---

## Definitive Answer

**There is no env var that reliably detects "VS Code + Copilot agent mode" from within an MCP server process.** The best you can do today:

1. Check `TERM_PROGRAM === 'vscode'` or presence of `VSCODE_IPC_HOOK_CLI` to detect VS Code.
2. Check the filesystem for `github.copilot` in the extensions directory to infer Copilot is installed.
3. There is no way to detect agent mode vs. chat mode vs. manual invocation.
4. The VS Code team has acknowledged this gap (issue #265446 closed as dup of internal tracking).

---

## Sources
- [microsoft/vscode#265446 - Feature Request: Copilot Terminal Env Var](https://github.com/microsoft/vscode/issues/265446)
- [VS Code MCP Server Docs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
- [VS Code MCP Configuration Reference](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration)
- [GitHub Community Discussion #160030](https://github.com/orgs/community/discussions/160030)
- [microsoft/vscode#244621 - MCP env var issue](https://github.com/microsoft/vscode/issues/244621)
- [Copilot CLI Config Files](https://inventivehq.com/knowledge-base/copilot/where-configuration-files-are-stored)
