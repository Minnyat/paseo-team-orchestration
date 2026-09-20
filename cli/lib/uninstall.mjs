/**
 * uninstall.mjs — the inverse of scripts/install.* plus the pack's runtime
 * footprints. Every removal is scoped to artifacts this pack owns:
 *
 *   - shared locations (the prompts dir, the skills dir, mcp.json) only ever
 *     lose *named items* — never a whole directory or file another tool may
 *     also live in.
 *   - the pack's config directory holds the permit audit log, an accountability record
 *     of every allow/deny decision, so it survives uninstall unless --purge
 *     explicitly asks for it.
 *
 * Idempotent by design: a second run reports every target as "missing" and
 * still succeeds, so uninstall can be re-run after a partial failure.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as cw from "./config-walker.mjs";
import * as claudeSetup from "../../scripts/claude-setup.mjs";

/**
 * The one PI mcp.json server entry the pack used to add. It no longer installs
 * a browser at all — both runtimes use one they already have — but uninstall
 * must still know the name, or a host that was set up by an older version keeps
 * a dangling server entry forever. The Claude copy of the same entry lives in
 * ~/.claude.json and is removed by claudeSetup.uninstall(), which owns that
 * file.
 */
export const MCP_ENTRY = "agent-browser";

export function teamScriptsDir() {
	return join(cw.extensionsDir(), "paseo-team-scripts");
}

function removePath(kind, absPath) {
	if (!existsSync(absPath)) return { kind, path: absPath, status: "missing" };
	try {
		rmSync(absPath, { recursive: true, force: true });
	} catch (error) {
		// A locked file (editor/antivirus on Windows) fails that one target,
		// not the whole command — same degrade-don't-crash contract as graph.
		return { kind, path: absPath, status: "failed", error: String(error?.message ?? error) };
	}
	return { kind, path: absPath, status: "removed" };
}

/** Removes only the pack's own server entry; other tools' entries stay. */
export function removeMcpEntry(mcpPath = cw.mcpConfigPath()) {
	// A present-but-corrupt file is NOT "no config": the entry may still be in
	// there, and rewriting the file could destroy whatever else is. Report it
	// and leave the bytes alone.
	if (!existsSync(mcpPath)) return { path: mcpPath, entry: MCP_ENTRY, status: "mcp-config-missing" };
	let cfg;
	try {
		cfg = JSON.parse(cw.readText(mcpPath));
	} catch (error) {
		return {
			path: mcpPath,
			entry: MCP_ENTRY,
			status: "mcp-config-unreadable",
			error: String(error?.message ?? error),
		};
	}
	if (
		cfg === null ||
		typeof cfg !== "object" ||
		Array.isArray(cfg) ||
		!cfg.mcpServers ||
		typeof cfg.mcpServers !== "object" ||
		Array.isArray(cfg.mcpServers) ||
		!(MCP_ENTRY in cfg.mcpServers)
	) {
		return { path: mcpPath, entry: MCP_ENTRY, status: "entry-missing" };
	}
	delete cfg.mcpServers[MCP_ENTRY];
	// atomicWriteJson parks a timestamped backup next to mcp.json, so even a
	// wrong removal is recoverable from the .bak-* sibling.
	cw.atomicWriteJson(mcpPath, JSON.stringify(cfg));
	return { path: mcpPath, entry: MCP_ENTRY, status: "removed" };
}

/**
 * Directory holding the policy modules shared by the pi extension and the
 * Claude hook. Installed next to the extension, removed with it — leaving it
 * behind would keep a Claude hook working after the pack is gone.
 */
export const POLICY_CORE_DIR = "paseo-team-core";

/**
 * Claude Code side: the tagged hook entries in ~/.claude/settings.json and the
 * paseo-team MCP server in ~/.claude.json. Both files belong to the user and
 * carry other tools' entries, so only this pack's tagged items are removed —
 * the same named-items-only rule the mcp.json removal follows.
 *
 * A failure here degrades to a reported status instead of aborting: the pi
 * side of the uninstall must still complete.
 */
export function removeClaudeIntegration() {
	try {
		const result = claudeSetup.uninstall();
		return {
			kind: "claude-integration",
			settings: result.hooks,
			mcp: result.mcp,
			skills: result.skills,
			status: result.ok
				? [result.hooks.status, result.mcp.status, result.skills.status].includes(
						"updated",
					)
					? "removed"
					: "missing"
				: "failed",
		};
	} catch (error) {
		return {
			kind: "claude-integration",
			status: "failed",
			error: String(error?.message ?? error),
		};
	}
}

export function uninstall({ purge = false } = {}) {
	const targets = [
		removePath("policy-extension", cw.policyExtensionPath()),
		removePath("policy-core", join(cw.extensionsDir(), POLICY_CORE_DIR)),
		...cw.ROLE_PROMPTS.map((role) => removePath(`prompt-${role}`, cw.rolePromptPath(role))),
		...cw.PACK_SKILLS.map((name) => removePath(`skill-${name}`, cw.skillDirPath(name))),
		removePath("team-scripts", teamScriptsDir()),
	];
	const mcp = removeMcpEntry();
	const claude = removeClaudeIntegration();

	const teamDir = cw.teamConfigDir();
	let teamData;
	if (purge) {
		teamData = removePath("team-data", teamDir);
	} else {
		teamData = {
			kind: "team-data",
			path: teamDir,
			status: existsSync(teamDir) ? "kept" : "missing",
			reason: "holds the permit audit log; re-run with --purge to delete it",
		};
	}

	const all = [...targets, mcp, teamData, claude];
	return {
		purge,
		targets,
		mcp,
		claude,
		teamData,
		summary: {
			removed: all.filter((t) => t.status === "removed").length,
			missing: all.filter((t) => ["missing", "entry-missing", "mcp-config-missing"].includes(t.status)).length,
			failed: all.filter((t) => t.status === "failed").length,
			kept: all.filter((t) => t.status === "kept").length,
		},
	};
}
