/**
 * config-walker.mjs — "source of truth" for every path a role-pack config can
 * touch. Shared by the CLI (`paseo-team`) and only invoked by scripts that own
 * a real operation (read/write). The WebUI never imports this: it always goes
 * through `paseo-team` subcommands, which reach file I/O here and nowhere else.
 *
 * Path resolution honors the same env overrides the installers use, so tests
 * and the WebUI can point at a throwaway HOME:
 *   PI_HOME               -> default ~/.pi
 *   PI_CODING_AGENT_DIR   -> default $PI_HOME/agent
 *   PST_TEAM_CONFIG_DIR   -> default ~/.paseo-team-orchestration, or ~/.paseo-pi-team
 *                            when that legacy directory already exists
 *                            (PASEO_TEAM_HOME also honoured)
 *   PASEO_CONFIG_JSON     -> default ~/.paseo/config.json
 */

import { teamConfigDir as sharedTeamConfigDir } from "../../scripts/lib-common.mjs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
	mkdirSync,
	writeFileSync,
	renameSync,
	copyFileSync,
	existsSync,
	readFileSync,
} from "node:fs";

export function piHome() {
	return process.env.PI_HOME || join(homedir(), ".pi");
}

export function agentDir() {
	return process.env.PI_CODING_AGENT_DIR || join(piHome(), "agent");
}

export function teamConfigDir() {
	// One resolver, shared with the support scripts through lib-common: this
	// used to honour only PST_TEAM_CONFIG_DIR while model-routing.mjs honoured
	// only PASEO_TEAM_HOME, so `pteam status` and `pteam preflight` could name
	// different routing files on the same host.
	return sharedTeamConfigDir(process.env);
}

export function paseoConfigPath() {
	// Layered, not just the test override: `paseoHome()` below honours Paseo's
	// own PASEO_HOME and this did not, so a machine that moved its daemon home
	// had the pack reading agent state from the new tree and the daemon CONFIG
	// from the old one. Preflight could then pass `paseo-browser-tools` on a
	// host whose real config has the browser disabled.
	return process.env.PASEO_CONFIG_JSON || join(paseoHome(), "config.json");
}

/**
 * Paseo's own home. `PASEO_HOME` is Paseo's documented override, so honor the
 * same variable rather than inventing a pack-specific one — a machine that
 * moved its daemon home must not end up with the CLI reading a different tree
 * than the daemon writes.
 */
export function paseoHome() {
	return process.env.PASEO_HOME || join(homedir(), ".paseo");
}

/** Per-agent state files: `$PASEO_HOME/agents/<cwd-slug>/<agent-id>.json`. */
export function paseoAgentsDir() {
	return join(paseoHome(), "agents");
}

export function mcpConfigPath() {
	return join(agentDir(), "mcp.json");
}

/**
 * Pi's own settings file (`~/.pi/agent/settings.json`). It is shared with the
 * interactive `pi` CLI, so every write must merge, never clobber.
 */
export function piSettingsPath() {
	return join(agentDir(), "settings.json");
}

/**
 * pi's hand-written model inventory (layer 1 of model routing). pi has no
 * discovery, so this file IS the catalog; `pteam models sync` rewrites one
 * provider entry in it.
 */
export function piModelsPath() {
	return join(agentDir(), "models.json");
}

export function promptsDir() {
	return join(agentDir(), "extensions", "prompts");
}

export function skillsDir() {
	return join(agentDir(), "skills");
}

export function extensionsDir() {
	return join(agentDir(), "extensions");
}

export function policyExtensionPath() {
	return join(extensionsDir(), "paseo-team-policy.ts");
}

/**
 * Well-known role prompts this pack ships/installs.
 */
export const ROLE_PROMPTS = ["supervisor", "lead", "peer"];

export function rolePromptPath(role) {
	if (!ROLE_PROMPTS.includes(role)) {
		throw new Error(`unknown role prompt '${role}' (expected one of: ${ROLE_PROMPTS.join(", ")})`);
	}
	return join(promptsDir(), `${role}.md`);
}

/**
 * Well-known skip/first-class skills installed by the pack. Anything else in
 * skillsDir() is still listable by generic name.
 */
export const PACK_SKILLS = ["paseo-team-lead", "paseo-ocr-reviewer"];

export function skillDirPath(name) {
	return join(skillsDir(), name);
}

export function skillPromptPath(name) {
	return join(skillsDir(), name, "SKILL.md");
}

/**
 * Escape any name so it cannot traverse into an arbitrary path.
 */
export function safeName(name) {
	if (typeof name !== "string" || name.length === 0 || /[\\/]|\.\./.test(name)) {
		throw new Error(`unsafe name: '${name}'`);
	}
	return name;
}

/**
 * Atomic write with a timestamped backup. Never leaves a half-written file:
 * write to a temp sibling then rename over the destination. If the destination
 * already exists we first copy it to <name>.bak-<ts>.
 */
export function atomicWriteJson(absPath, data) {
	const parsed = JSON.parse(data); // throws early on invalid JSON
	atomicWrite(absPath, JSON.stringify(parsed, null, 2) + "\n");
	return parsed;
}

export function atomicWrite(absPath, content) {
	ensureDir(dirname(absPath));
	if (existsSync(absPath)) {
		copyFileSync(absPath, `${absPath}.bak-${Date.now()}`);
	}
	const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, absPath);
}

export function ensureDir(dir) {
	mkdirSync(dir, { recursive: true });
}

export function readJsonOrNull(absPath) {
	if (!existsSync(absPath)) return null;
	try {
		return JSON.parse(readText(absPath));
	} catch {
		return null;
	}
}

export function readText(absPath) {
	return readFileSync(absPath, "utf8");
}