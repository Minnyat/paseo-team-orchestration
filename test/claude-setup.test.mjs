// claude-setup.test.mjs — installing the Claude half of the pack.
//
// ~/.claude/settings.json and ~/.claude.json belong to the USER and already
// carry other tools' entries (Paseo installs its own hooks in the same file).
// The contract under test: merge, never replace; tag our own entries so an
// upgrade updates instead of duplicating; remove only what we added; and never
// rewrite a file we could not parse.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { installDrift } from "../cli/lib/install-drift.mjs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyNextSteps,
	applyProviders,
	buildProviderSnippet,
	claudeProviderLedgerPath,
	claudeSettingsPath,
	claudeUserConfigPath,
	removeProviders,
	hookEntry,
	hookScriptPath,
	install,
	installedHookScripts,
	installedHookCommands,
	durableNodeCandidates,
	nodeExecPath,
	mergeHooks,
	mergeMcpServer,
	normalizePath,
	removeHooks,
	removeMcpServer,
	uninstall,
	verify,
	claudeSkillsDir,
	installSkills,
	missingSkills,
	packSkillSources,
	removeSkills,
	skillIsOurs,
	SKILL_OWNER_MARKER,
	LEGACY_BROWSER_MCP_SERVER,
	isOwnBrowserMcpServer,
	removeBrowserMcpServer,
	HOOK_EVENTS,
	PASEO_TEAM_HOOK_TAG,
	TEAM_MCP_SERVER_NAME,
} from "../scripts/claude-setup.mjs";
import { seatLedgerPath } from "../scripts/seat-profiles.mjs";
import { teamConfigDir } from "../scripts/lib-common.mjs";

const home = mkdtempSync(join(tmpdir(), "paseo-claude-setup-"));
const claudeDir = join(home, ".claude");
mkdirSync(claudeDir, { recursive: true });
const userConfigPath = join(home, ".claude.json");
const env = {
	...process.env,
	CLAUDE_CONFIG_DIR: claudeDir,
	PASEO_TEAM_CLAUDE_USER_CONFIG: userConfigPath,
	PASEO_CONFIG_JSON: join(home, "paseo-config.json"),
	PST_TEAM_CONFIG_DIR: home,
};

assert.equal(claudeSettingsPath(env), join(claudeDir, "settings.json"));
assert.equal(claudeUserConfigPath(env), userConfigPath);
// The user config is NOT under CLAUDE_CONFIG_DIR: without its own override a
// test run would edit the developer's real MCP config.
assert.notEqual(claudeUserConfigPath({}), join(claudeDir, ".claude.json"));

// --- pure merges --------------------------------------------------------------

{
	// A foreign hook (Paseo's own) must survive ours being added.
	const foreign = {
		matcher: "",
		hooks: [{ type: "command", command: "paseo hooks claude UserPromptSubmit" }],
	};
	const settings = { model: "opus", hooks: { UserPromptSubmit: [foreign] } };
	const merged = mergeHooks(settings, env);
	assert.equal(merged.model, "opus");
	assert.deepEqual(merged.hooks.UserPromptSubmit[0], foreign);
	assert.equal(merged.hooks.UserPromptSubmit.length, 2);
	for (const event of Object.keys(HOOK_EVENTS)) {
		const ours = merged.hooks[event].filter((entry) => entry[PASEO_TEAM_HOOK_TAG]);
		assert.equal(ours.length, 1, `${event}: exactly one tagged entry`);
		assert.match(ours[0].hooks[0].command, /claude-hook\.mjs" [a-z-]+$/);
	}
	// Input is never mutated.
	assert.equal(settings.hooks.UserPromptSubmit.length, 1);

	// Re-merging replaces our entry instead of appending a second one.
	const twice = mergeHooks(merged, env);
	assert.equal(twice.hooks.PreToolUse.length, 1);
	assert.equal(twice.hooks.UserPromptSubmit.length, 2);

	// Removal takes ours out and leaves the foreign one.
	const removed = removeHooks(twice);
	assert.deepEqual(removed.hooks.UserPromptSubmit, [foreign]);
	assert.equal(removed.hooks.PreToolUse, undefined, "empty event key is dropped");
}

{
	// An untagged legacy entry pointing at our script is still ours.
	const legacy = {
		matcher: "*",
		hooks: [{ type: "command", command: "node /old/path/claude-hook.mjs pre-tool-use" }],
	};
	const merged = mergeHooks({ hooks: { PreToolUse: [legacy] } }, env);
	assert.equal(merged.hooks.PreToolUse.length, 1, "upgraded in place, not duplicated");
	assert.equal(merged.hooks.PreToolUse[0][PASEO_TEAM_HOOK_TAG], true);
}

{
	const config = { mcpServers: { other: { type: "stdio", command: "x" } } };
	const merged = mergeMcpServer(config, env);
	assert.deepEqual(merged.mcpServers.other, { type: "stdio", command: "x" });
	assert.equal(merged.mcpServers[TEAM_MCP_SERVER_NAME].type, "stdio");
	assert.match(merged.mcpServers[TEAM_MCP_SERVER_NAME].args[0], /claude-team-mcp\.mjs$/);
	const removed = removeMcpServer(merged);
	assert.deepEqual(Object.keys(removed.mcpServers), ["other"]);
	// Removing when absent is a no-op, not an error.
	assert.deepEqual(removeMcpServer({ mcpServers: {} }).mcpServers, {});
	assert.deepEqual(removeMcpServer({}), {});
}

// Hook commands use forward slashes even on Windows: they may be handed to a
// shell, where a backslash path would be read as escapes.
{
	const entry = hookEntry("PreToolUse", env);
	assert.ok(!entry.hooks[0].command.includes("\\"), entry.hooks[0].command);
	// Empty matcher = all tools, the same form Paseo's own hooks use in this
	// file. A matcher that matches nothing would disable the policy silently.
	assert.equal(entry.matcher, "");
	assert.equal(hookEntry("SessionStart", env).matcher, "");
	assert.ok(normalizePath("C:\\a\\b").endsWith("/a/b") || normalizePath("/a/b").endsWith("/a/b"));
}

// --- install / verify / uninstall on disk ------------------------------------

{
	writeFileSync(
		join(claudeDir, "settings.json"),
		JSON.stringify({ model: "opus[1m]", hooks: { Stop: [{ matcher: "", hooks: [] }] } }, null, 2),
		"utf8",
	);
	writeFileSync(userConfigPath, JSON.stringify({ mcpServers: { other: {} } }, null, 2), "utf8");

	const before = await verify(env);
	assert.equal(before.ok, false);
	assert.ok(before.missing.includes("hook:PreToolUse"));

	const installed = await install(env);
	assert.equal(installed.ok, true);
	assert.equal(installed.hooks.status, "updated");
	assert.equal(installed.mcp.status, "updated");

	const after = await verify(env);
	assert.equal(after.ok, true, JSON.stringify(after.missing));
	assert.deepEqual(after.hooks, { SessionStart: true, UserPromptSubmit: true, PreToolUse: true });
	assert.equal(after.mcpServer, true);

	// Idempotent: a second install changes nothing on disk.
	const again = await install(env);
	assert.equal(again.hooks.status, "unchanged");
	assert.equal(again.mcp.status, "unchanged");

	// The user's own settings survived.
	const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
	assert.equal(settings.model, "opus[1m]");
	assert.ok(settings.hooks.Stop);
	// A backup was parked next to the file before the first write.
	assert.ok(readdirSync(claudeDir).some((name) => name.includes("settings.json.bak-")));

	const removedResult = await uninstall(env);
	assert.equal(removedResult.ok, true);
	const settingsAfter = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
	assert.equal(settingsAfter.model, "opus[1m]");
	assert.ok(settingsAfter.hooks.Stop, "foreign hooks survive uninstall");
	assert.equal(settingsAfter.hooks.PreToolUse, undefined);
	const configAfter = JSON.parse(readFileSync(userConfigPath, "utf8"));
	assert.deepEqual(Object.keys(configAfter.mcpServers), ["other"]);
	assert.equal((await verify(env)).ok, false);
}

// A present-but-corrupt file is reported, never rewritten.
{
	const corruptDir = mkdtempSync(join(tmpdir(), "paseo-claude-corrupt-"));
	const corruptSettings = join(corruptDir, "settings.json");
	writeFileSync(corruptSettings, "{ not json", "utf8");
	const corruptEnv = {
		...process.env,
		CLAUDE_CONFIG_DIR: corruptDir,
		PASEO_TEAM_CLAUDE_USER_CONFIG: join(corruptDir, ".claude.json"),
		PASEO_CONFIG_JSON: join(corruptDir, "paseo-config.json"),
		PST_TEAM_CONFIG_DIR: corruptDir,
	};
	const result = await install(corruptEnv);
	assert.equal(result.ok, false);
	assert.equal(result.hooks.status, "failed");
	assert.equal(readFileSync(corruptSettings, "utf8"), "{ not json", "bytes untouched");
	// The other file is independent and still gets installed.
	assert.equal(result.mcp.status, "created");
	rmSync(corruptDir, { recursive: true, force: true });
}

// A missing settings file is created rather than treated as an error.
{
	const freshDir = join(home, "fresh");
	const freshEnv = {
		...process.env,
		CLAUDE_CONFIG_DIR: freshDir,
		PASEO_TEAM_CLAUDE_USER_CONFIG: join(freshDir, ".claude.json"),
		PASEO_CONFIG_JSON: join(freshDir, "paseo-config.json"),
		PST_TEAM_CONFIG_DIR: freshDir,
	};
	const result = await install(freshEnv);
	assert.equal(result.hooks.status, "created");
	assert.ok(existsSync(join(freshDir, "settings.json")));
}

// --- verify reports the REGISTERED script, not the one we would install -------
//
// A hook left pointing at a moved checkout is the stale-install failure mode
// this command exists to catch, so verify must read the path out of the
// settings file and check every one of them.
{
	const staleDir = mkdtempSync(join(tmpdir(), "paseo-claude-stale-"));
	const staleEnv = {
		...process.env,
		CLAUDE_CONFIG_DIR: staleDir,
		PASEO_TEAM_CLAUDE_USER_CONFIG: join(staleDir, ".claude.json"),
		PASEO_CONFIG_JSON: join(staleDir, "paseo-config.json"),
		PST_TEAM_CONFIG_DIR: staleDir,
	};
	await install(staleEnv);
	const settingsFile = join(staleDir, "settings.json");
	const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
	assert.deepEqual(installedHookScripts(settings), [hookScriptPath(staleEnv)]);
	assert.deepEqual(installedHookScripts({}), []);
	assert.equal((await verify(staleEnv)).ok, true);

	// Break ONE event only: a partially re-pointed install must still fail.
	for (const entry of settings.hooks.PreToolUse) {
		if (!entry[PASEO_TEAM_HOOK_TAG]) continue;
		entry.hooks[0].command = entry.hooks[0].command.replace(
			/"[^"]+claude-hook\.mjs"/,
			'"/nowhere/claude-hook.mjs"',
		);
	}
	writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf8");
	const stale = await verify(staleEnv);
	assert.equal(stale.ok, false, "a hook pointing at a missing script is not ok");
	assert.ok(stale.missing.some((item) => item.includes("/nowhere/claude-hook.mjs")));
	assert.ok(stale.hookScripts.includes("/nowhere/claude-hook.mjs"));

	// The INTERPRETER is checked too, and this is the case that used to be both
	// the worst and the quietest. The registered command names an absolute node
	// path; a version manager retiring that path leaves three hooks that cannot
	// start, and a hook that cannot start DENIES — every tool call, on every
	// Claude seat, with nothing naming the cause. verify used to report ok.
	const fresh = JSON.parse(readFileSync(settingsFile, "utf8"));
	for (const event of Object.keys(HOOK_EVENTS)) {
		for (const entry of fresh.hooks[event] ?? []) {
			if (!entry[PASEO_TEAM_HOOK_TAG]) continue;
			entry.hooks[0].command = entry.hooks[0].command.replace(
				/^"[^"]+"/,
				'"/gone/node/22.23.2/bin/node"',
			);
		}
	}
	writeFileSync(settingsFile, JSON.stringify(fresh, null, 2), "utf8");
	const deadNode = await verify(staleEnv);
	assert.equal(deadNode.ok, false, "a hook whose interpreter is gone is not ok");
	assert.ok(
		deadNode.missing.includes("interpreter:/gone/node/22.23.2/bin/node"),
		"the missing entry names the interpreter, not just 'something is wrong'",
	);
	assert.ok(deadNode.missingInterpreters.includes("/gone/node/22.23.2/bin/node"));
	// Both halves of the command are recovered from the settings file.
	const commands = installedHookCommands(fresh);
	assert.deepEqual(commands.interpreters, ["/gone/node/22.23.2/bin/node"]);
	// Both the healthy script and the one the previous block re-pointed: all
	// three events are read, so a partially broken install cannot hide behind
	// the two that are still fine.
	assert.deepEqual(commands.scripts.sort(), [
		"/nowhere/claude-hook.mjs",
		hookScriptPath(staleEnv),
	].sort());
	assert.deepEqual(installedHookCommands({}), { interpreters: [], scripts: [] });

	rmSync(staleDir, { recursive: true, force: true });
}

// --- the interpreter written into a hook must outlive a node upgrade ----------
// `process.execPath` under a version manager is an exact patch directory
// (installing from a mise shell wrote `.../installs/node/22.23.2/bin/node`),
// and the next `mise upgrade node` deletes it. Prefer the alias that survives.
{
	// Only the version SEGMENT is rewritten, and only to a prefix of itself, so
	// the major version — and with it the `engines` floor — is never traded away.
	assert.deepEqual(
		durableNodeCandidates("/home/u/.local/share/mise/installs/node/22.23.2/bin/node"),
		[
			"/home/u/.local/share/mise/installs/node/22/bin/node",
			"/home/u/.local/share/mise/installs/node/22.23/bin/node",
		],
		"most durable first",
	);
	// The `v` prefix nvm/fnm use is preserved, or the candidate would not exist.
	assert.deepEqual(
		durableNodeCandidates("/home/u/.nvm/versions/node/v22.23.2/bin/node"),
		[
			"/home/u/.nvm/versions/node/v22/bin/node",
			"/home/u/.nvm/versions/node/v22.23/bin/node",
		],
	);
	// A Windows path arrives with backslashes and must come back usable. The
	// separators are normalized but the path is NOT resolved: resolving would
	// staple the current drive onto every POSIX-looking case above, which is
	// how this test would pass on Linux and fail on the Windows CI runner.
	assert.deepEqual(
		durableNodeCandidates(String.raw`C:\Users\u\AppData\Roaming\nvm\v22.23.2\node.exe`),
		[
			"C:/Users/u/AppData/Roaming/nvm/v22/node.exe",
			"C:/Users/u/AppData/Roaming/nvm/v22.23/node.exe",
		],
	);

	// Nothing version-shaped (a distro or Windows install) → nothing to prefer.
	assert.deepEqual(durableNodeCandidates("/usr/bin/node"), []);
	assert.deepEqual(durableNodeCandidates("C:/Program Files/nodejs/node.exe"), []);
	// A bare major is already as durable as it gets: rewriting it to nothing
	// would produce a path with an empty segment.
	assert.deepEqual(durableNodeCandidates("/opt/node/22/bin/node"), []);

	// An operator who knows their layout beats the heuristic outright.
	//
	// The override is resolved, the way `hookScriptPath` already resolves its
	// own — so the expectation has to be absolute in the PLATFORM's terms, not
	// in POSIX's. A bare "/opt/..." picks up the current drive on Windows
	// ("D:/opt/..."), which is correct behaviour and a wrong expectation.
	const pinned = process.platform === "win32" ? "C:/opt/pinned/node" : "/opt/pinned/node";
	assert.equal(nodeExecPath({ PASEO_TEAM_NODE_EXEC: pinned }), pinned);
	// Whatever comes back carries no backslashes, on any platform: the value is
	// interpolated into a command string a shell may read, where a backslash is
	// an escape. Asserted as the property rather than as a literal, so it says
	// something real on both runners instead of restating normalizePath.
	for (const given of [pinned, String.raw`C:\opt\pinned\node.exe`]) {
		assert.doesNotMatch(nodeExecPath({ PASEO_TEAM_NODE_EXEC: given }), /\\/);
	}
	// With no candidate on disk, the running interpreter stands — the old
	// behaviour, which was never wrong so much as unnecessarily fragile.
	assert.equal(nodeExecPath({}), normalizePath(nodeExecPath({})));
	assert.ok(existsSync(nodeExecPath({})), "whatever is chosen must actually exist");
}

// --- provider snippet ---------------------------------------------------------

{
	const snippet = await buildProviderSnippet(env);
	const providers = snippet.agents.providers;
	assert.deepEqual(Object.keys(providers).sort(), [
		"claude-lead",
		"claude-peer",
		"claude-supervisor",
	]);
	for (const [name, provider] of Object.entries(providers)) {
		assert.equal(provider.extends, "claude");
		assert.equal(provider.env.PASEO_PI_ROLE, name.replace("claude-", ""));
		assert.ok(provider.disallowedTools.includes("Task"));
	}
	assert.ok(providers["claude-supervisor"].disallowedTools.includes("Bash"));
	assert.ok(!providers["claude-peer"].disallowedTools.includes("Write"));

	// Claude in Chrome. A Paseo seat is non-interactive, and Claude Code's
	// enablement order disables the integration on a non-interactive session
	// BEFORE it reads claudeInChromeDefaultEnabled from ~/.claude.json — so the
	// host config can never switch it on for a seat. CLAUDE_CODE_ENABLE_CFC is
	// evaluated above that gate and is the only lever a seat can pull.
	//
	// The literal string is deliberate: this name is a contract with Claude Code,
	// not an internal symbol. Importing the constant would keep passing if it were
	// renamed to something Claude Code does not read.
	for (const role of ["lead", "peer"]) {
		assert.equal(
			providers[`claude-${role}`].env.CLAUDE_CODE_ENABLE_CFC,
			"1",
			`claude-${role} carries the Claude-in-Chrome lever`,
		);
	}
	// The Supervisor is denied every browser surface by its own disallowedTools;
	// the key must be ABSENT, not "0" — a seat advertising tools its policy
	// rejects on every call is a contradiction, not a safe default.
	assert.ok(
		!("CLAUDE_CODE_ENABLE_CFC" in providers["claude-supervisor"].env),
		"claude-supervisor has no Claude-in-Chrome key at all",
	);

	// The checked-in example config must match what the code generates, or an
	// operator who copies it gets a policy the code does not enforce.
	const example = JSON.parse(
		readFileSync(new URL("../config/paseo.providers.example.json", import.meta.url), "utf8"),
	);
	for (const [name, provider] of Object.entries(providers)) {
		assert.deepEqual(example.agents.providers[name], provider, `${name} drifted from the generator`);
	}
	assert.ok(example.agents.providers["pi-peer"], "pi providers stay in the example");
}

// --- the browser server is GONE, and an old one gets cleaned up --------------
//
// The pack used to register an `agent-browser` stdio server here so that a Lead
// (and a granted Peer) had something to call. Both runtimes now use a browser
// they already have — Paseo Browser Control, injected into every seat by the
// daemon, and Claude in Chrome — so this installer registers no browser, and an
// install has to clear the entry an older version wrote or every upgraded host
// keeps a dangling server pointing at an uninstalled CLI.
{
	const legacyDir = mkdtempSync(join(tmpdir(), "paseo-claude-browser-"));
	const legacyConfig = join(legacyDir, ".claude.json");
	const legacyEnv = {
		...process.env,
		CLAUDE_CONFIG_DIR: legacyDir,
		PASEO_TEAM_CLAUDE_USER_CONFIG: legacyConfig,
		PASEO_CONFIG_JSON: join(legacyDir, "paseo-config.json"),
		PST_TEAM_CONFIG_DIR: legacyDir,
	};
	// A host set up by the previous version: our launch-mode entry, plus one
	// unrelated server that must survive untouched.
	writeFileSync(
		legacyConfig,
		JSON.stringify(
			{
				mcpServers: {
					other: { command: "x" },
					[LEGACY_BROWSER_MCP_SERVER]: {
						type: "stdio",
						command: "agent-browser",
						args: ["mcp"],
					},
				},
			},
			null,
			2,
		),
		"utf8",
	);

	const installed = await install(legacyEnv);
	assert.equal(installed.ok, true);
	const config = JSON.parse(readFileSync(legacyConfig, "utf8"));
	assert.ok(config.mcpServers[TEAM_MCP_SERVER_NAME], "the team server is installed");
	assert.equal(
		config.mcpServers[LEGACY_BROWSER_MCP_SERVER],
		undefined,
		"the browser entry this installer used to write is cleaned up",
	);
	assert.deepEqual(config.mcpServers.other, { command: "x" }, "other servers are untouched");

	// verify no longer knows about a browser server at all, and must still pass.
	const after = await verify(legacyEnv);
	assert.equal(after.ok, true, JSON.stringify(after.missing));
	assert.equal(after.browserMcpServer, undefined);
	assert.ok(!after.missing.some((entry) => entry.includes("agent-browser")));

	// Idempotent: the second install writes nothing.
	assert.equal((await install(legacyEnv)).mcp.status, "unchanged");

	await uninstall(legacyEnv);
	const cleaned = JSON.parse(readFileSync(legacyConfig, "utf8"));
	assert.equal(cleaned.mcpServers[TEAM_MCP_SERVER_NAME], undefined);
	assert.deepEqual(cleaned.mcpServers.other, { command: "x" });
	rmSync(legacyDir, { recursive: true, force: true });
}

// --- cleanup is still ownership-bounded --------------------------------------
{
	// The installer never rewrote a valid pre-existing entry, on the grounds
	// that agent-browser is a general-purpose tool a user may already run with
	// their own flags. Dropping our own integration does not license us to
	// delete theirs: we never took ownership of that entry.
	const mine = { type: "stdio", command: "agent-browser", args: ["mcp"] };
	const attached = { type: "stdio", command: "agent-browser", args: ["--cdp", "9333", "mcp"] };

	assert.ok(isOwnBrowserMcpServer(mine), "a launch-mode entry we wrote is ours");
	assert.ok(isOwnBrowserMcpServer(attached), "an --attach-cdp-port entry is ours too");
	assert.ok(
		isOwnBrowserMcpServer({ args: mine.args, command: mine.command, type: mine.type }),
		"key order is not identity — a re-serialized file still matches",
	);
	// Anything the user shaped is theirs, whatever it resembles.
	assert.equal(isOwnBrowserMcpServer({ ...mine, disabled: false }), false);
	assert.equal(isOwnBrowserMcpServer({ ...mine, args: ["mcp", "--tools", "click"] }), false);
	assert.equal(isOwnBrowserMcpServer({ ...mine, command: "my-agent-browser" }), false);
	assert.equal(isOwnBrowserMcpServer(null), false);
	assert.equal(isOwnBrowserMcpServer({ command: "agent-browser" }), false, "no args is not ours");

	const theirs = {
		mcpServers: {
			[LEGACY_BROWSER_MCP_SERVER]: {
				type: "stdio",
				command: "agent-browser",
				args: ["--cdp", "9222", "mcp"],
				disabled: false,
			},
		},
	};
	assert.deepEqual(
		removeBrowserMcpServer(theirs).mcpServers[LEGACY_BROWSER_MCP_SERVER],
		theirs.mcpServers[LEGACY_BROWSER_MCP_SERVER],
		"an entry the user configured survives",
	);
	assert.equal(
		removeBrowserMcpServer({ mcpServers: { [LEGACY_BROWSER_MCP_SERVER]: mine } })
			.mcpServers[LEGACY_BROWSER_MCP_SERVER],
		undefined,
		"the entry we wrote is removed",
	);
	assert.deepEqual(removeBrowserMcpServer({}), {});
}

// --- --apply: merging the provider block into ~/.paseo/config.json -----------
//
// ~/.paseo/config.json belongs to the operator and the daemon writes it too, so
// apply follows the same discipline as the two files above: back up, merge,
// never overwrite something we did not write, and never rewrite a file we could
// not parse.

const ROLE_PROVIDERS = ["claude-lead", "claude-peer", "claude-supervisor"];

function applySandbox(tag) {
	const dir = mkdtempSync(join(tmpdir(), `paseo-claude-${tag}-`));
	const configPath = join(dir, "paseo-config.json");
	return {
		dir,
		configPath,
		read: () => JSON.parse(readFileSync(configPath, "utf8")),
		env: {
			...process.env,
			CLAUDE_CONFIG_DIR: join(dir, ".claude"),
			PASEO_TEAM_CLAUDE_USER_CONFIG: join(dir, ".claude.json"),
			PASEO_CONFIG_JSON: configPath,
			PST_TEAM_CONFIG_DIR: dir,
		},
	};
}

// A fresh host: no config file at all, then idempotent on the second run.
{
	const s = applySandbox("apply-fresh");
	const fresh = await applyProviders(s.env);
	assert.equal(fresh.ok, true);
	assert.equal(fresh.status, "created");
	assert.deepEqual([...fresh.created].sort(), ROLE_PROVIDERS);

	const written = s.read();
	assert.equal(written.agents.providers["claude-peer"].env.CLAUDE_CODE_ENABLE_CFC, "1");
	assert.equal(written.agents.providers["claude-lead"].env.CLAUDE_CODE_ENABLE_CFC, "1");
	assert.equal(
		written.agents.providers["claude-supervisor"].env.CLAUDE_CODE_ENABLE_CFC,
		undefined,
		"the Supervisor is not given a browser it is denied",
	);

	// The ledger is a file of OUR own, not the seat ledger — sharing one would
	// make the next `seats apply` delete all three role providers.
	const ledgerPath = claudeProviderLedgerPath(s.env);
	assert.ok(existsSync(ledgerPath));
	assert.ok(ledgerPath.endsWith("claude-provider-ledger.json"));
	assert.ok(!ledgerPath.includes("seat"));

	// A distinct PATH is not the whole guarantee: a change could keep this file
	// and ALSO record the same names in the seat ledger, which would hand
	// `seats apply` the delete-when-absent power over them again. Assert on the
	// bytes actually written, so any second home for these names fails here.
	assert.equal(existsSync(seatLedgerPath(s.dir)), false, "the seat ledger is not created");
	for (const name of readdirSync(s.dir)) {
		// The config is where they SHOULD be; the claude ledger is the one record
		// of ownership. Anything else naming them is a second owner.
		if (name === "claude-provider-ledger.json" || name.startsWith("paseo-config.json")) continue;
		if (!name.endsWith(".json")) continue;
		const body = readFileSync(join(s.dir, name), "utf8");
		for (const provider of ROLE_PROVIDERS) {
			assert.ok(
				!body.includes(`"${provider}"`),
				`${name} must not claim ${provider} — only the claude ledger owns these`,
			);
		}
	}

	const again = await applyProviders(s.env);
	assert.equal(again.status, "unchanged", "a second apply writes nothing");
	assert.deepEqual([again.created, again.updated], [[], []]);
	rmSync(s.dir, { recursive: true, force: true });
}

// An unrelated config keeps everything it had; only agents.providers grows.
{
	const s = applySandbox("apply-merge");
	writeFileSync(
		s.configPath,
		JSON.stringify({ version: 1, daemon: { mcp: { enabled: true } }, agents: { providers: { "pi-lead": { extends: "pi" } } } }, null, 2),
		"utf8",
	);
	const result = await applyProviders(s.env);
	assert.equal(result.status, "updated");
	const after = s.read();
	assert.equal(after.version, 1, "unrelated top-level keys survive");
	assert.equal(after.daemon.mcp.enabled, true);
	assert.deepEqual(after.agents.providers["pi-lead"], { extends: "pi" }, "another provider is untouched");
	assert.ok(readdirSync(s.dir).some((n) => n.includes("paseo-config.json.bak-")), "backed up first");
	rmSync(s.dir, { recursive: true, force: true });
}

// A provider the operator hand-tuned is REPORTED, never clobbered — and --force
// records their original so uninstall can put it back exactly.
{
	const s = applySandbox("apply-tuned");
	const mine = { extends: "claude", label: "hand tuned by the operator", model: "sonnet" };
	writeFileSync(s.configPath, JSON.stringify({ agents: { providers: { "claude-peer": mine } } }, null, 2), "utf8");

	const refused = await applyProviders(s.env);
	assert.deepEqual(refused.skipped, ["claude-peer"]);
	assert.deepEqual(s.read().agents.providers["claude-peer"], mine, "not clobbered");
	assert.ok(refused.created.includes("claude-lead"), "the others still apply");

	const forced = await applyProviders(s.env, { force: true });
	assert.ok(forced.updated.includes("claude-peer"), "--force adopts it");
	assert.equal(s.read().agents.providers["claude-peer"].env.CLAUDE_CODE_ENABLE_CFC, "1");

	// Uninstall symmetry: what we created is deleted, what we replaced is restored.
	const backedOut = removeProviders(s.env);
	assert.deepEqual(backedOut.restored, ["claude-peer"]);
	assert.deepEqual([...backedOut.removed].sort(), ["claude-lead", "claude-supervisor"]);
	assert.deepEqual(s.read().agents.providers["claude-peer"], mine, "their original, byte for byte");
	assert.equal(existsSync(claudeProviderLedgerPath(s.env)), false, "the ledger goes with it");
	rmSync(s.dir, { recursive: true, force: true });
}

// A provider the operator DELETED on purpose is not resurrected without --force.
{
	const s = applySandbox("apply-deleted");
	await applyProviders(s.env);
	const config = s.read();
	delete config.agents.providers["claude-lead"];
	writeFileSync(s.configPath, JSON.stringify(config, null, 2), "utf8");

	const rerun = await applyProviders(s.env);
	assert.deepEqual(rerun.deletedByOperator, ["claude-lead"]);
	assert.equal(s.read().agents.providers["claude-lead"], undefined, "a deliberate deletion stands");
	// Still remembered as ours: forgetting it would make the NEXT run treat the
	// name as unknown and create it, resurrecting it one run late.
	const stillRerun = await applyProviders(s.env);
	assert.deepEqual(stillRerun.deletedByOperator, ["claude-lead"]);

	const forced = await applyProviders(s.env, { force: true });
	assert.ok(forced.created.includes("claude-lead"), "--force re-creates it");
	assert.ok("claude-lead" in s.read().agents.providers);
	rmSync(s.dir, { recursive: true, force: true });
}

// A provider we created but the operator has since edited is THEIRS: uninstall
// leaves it alone, the same exact-match rule isOwnBrowserMcpServer follows.
{
	const s = applySandbox("apply-adopted");
	await applyProviders(s.env);
	const config = s.read();
	config.agents.providers["claude-lead"].label = "renamed by the operator";
	writeFileSync(s.configPath, JSON.stringify(config, null, 2), "utf8");

	const backedOut = removeProviders(s.env);
	assert.deepEqual(backedOut.kept, ["claude-lead"]);
	assert.equal(
		s.read().agents.providers["claude-lead"].label,
		"renamed by the operator",
		"an entry reshaped after we wrote it survives uninstall",
	);
	assert.deepEqual([...backedOut.removed].sort(), ["claude-peer", "claude-supervisor"]);
	rmSync(s.dir, { recursive: true, force: true });
}

// A present-but-unparseable config is reported and left byte-for-byte alone.
{
	const s = applySandbox("apply-corrupt");
	writeFileSync(s.configPath, "{ not json", "utf8");
	const result = await applyProviders(s.env);
	assert.equal(result.ok, false);
	assert.equal(result.status, "failed");
	assert.match(result.error, /not a JSON object/);
	assert.equal(readFileSync(s.configPath, "utf8"), "{ not json", "bytes untouched");
	assert.equal(existsSync(claudeProviderLedgerPath(s.env)), false, "and nothing was claimed");

	// Uninstall is held to the same rule.
	writeFileSync(claudeProviderLedgerPath(s.env), JSON.stringify({ version: 1, providers: { "claude-lead": { mode: "created", wrote: {} } } }), "utf8");
	const backedOut = removeProviders(s.env);
	assert.equal(backedOut.ok, false);
	assert.equal(readFileSync(s.configPath, "utf8"), "{ not json", "bytes untouched");
	rmSync(s.dir, { recursive: true, force: true });
}

// Never applied means never touched: uninstall does not create or edit a config.
{
	const s = applySandbox("apply-noledger");
	const result = removeProviders(s.env);
	assert.equal(result.ok, true);
	assert.equal(result.status, "missing");
	assert.equal(existsSync(s.configPath), false, "uninstall does not create the file it cleans");
	rmSync(s.dir, { recursive: true, force: true });
}

// An entry WE created and the operator has since edited is THEIRS. This is the
// upgrade path — 6ac3e81 changed the generated block, so "run --apply again" is
// what every existing install does next, and that is exactly the run that must
// not discard their tuning.
{
	const s = applySandbox("apply-edited");
	await applyProviders(s.env);
	const config = s.read();
	config.agents.providers["claude-peer"].model = "operator's pinned model";
	writeFileSync(s.configPath, JSON.stringify(config, null, 2), "utf8");

	const rerun = await applyProviders(s.env);
	assert.deepEqual(rerun.skipped, ["claude-peer"], "reported, not silently taken");
	assert.equal(
		s.read().agents.providers["claude-peer"].model,
		"operator's pinned model",
		"an edit to a provider we created survives a later apply",
	);
	// Being in the ledger is not ownership on its own — the recorded entry has
	// to still match. Same comparison removeProviders makes.
	assert.ok(!rerun.updated.includes("claude-peer"));

	// --force does take it, and records THEIR version so uninstall restores it.
	const forced = await applyProviders(s.env, { force: true });
	assert.ok(forced.updated.includes("claude-peer"));
	assert.equal(s.read().agents.providers["claude-peer"].env.CLAUDE_CODE_ENABLE_CFC, "1");
	const backedOut = removeProviders(s.env);
	assert.deepEqual(backedOut.restored, ["claude-peer"]);
	assert.equal(
		s.read().agents.providers["claude-peer"].model,
		"operator's pinned model",
		"--force stored the operator's edited entry as `previous`",
	);
	rmSync(s.dir, { recursive: true, force: true });
}

// The operator's ORIGINAL survives a later skip.
//
// Full sequence: they own P; --force replaces it with W and records P; they
// edit W into E; a plain --apply then correctly skips the name (it is theirs
// again). Skipping must not drop the ledger entry, because that entry holds the
// only copy of P — and this pack promises in writing that --force records what
// it replaced.
//
// The second half pins the behaviour the narrowed promise describes: uninstall
// LEAVES E. It does not revert to P. Reverting would destroy their edit to
// restore something two steps stale, and an entry reshaped after we wrote it is
// theirs by the same exact-match rule isOwnBrowserMcpServer uses. Anyone reading
// "records what it replaced" and concluding the code should revert should find
// this test instead.
{
	const s = applySandbox("apply-skip-keeps-previous");
	const P = { extends: "claude", label: "the operator's own", model: "sonnet" };
	writeFileSync(s.configPath, JSON.stringify({ agents: { providers: { "claude-peer": P } } }, null, 2), "utf8");

	await applyProviders(s.env, { force: true });
	const W = s.read().agents.providers["claude-peer"];
	assert.equal(W.env.CLAUDE_CODE_ENABLE_CFC, "1", "--force took it");
	const ledgerPath = claudeProviderLedgerPath(s.env);
	assert.deepEqual(JSON.parse(readFileSync(ledgerPath, "utf8")).providers["claude-peer"].previous, P);

	// They edit our entry. It becomes theirs.
	const config = s.read();
	const E = { ...W, model: "edited-after-we-wrote-it" };
	config.agents.providers["claude-peer"] = E;
	writeFileSync(s.configPath, JSON.stringify(config, null, 2), "utf8");

	const rerun = await applyProviders(s.env);
	assert.deepEqual(rerun.skipped, ["claude-peer"], "correctly skipped — it is theirs now");
	const afterSkip = JSON.parse(readFileSync(ledgerPath, "utf8")).providers["claude-peer"];
	assert.deepEqual(afterSkip.previous, P, "P survives the skip — the record is not dropped");

	// And uninstall leaves E alone rather than reverting to P.
	const backedOut = removeProviders(s.env);
	assert.deepEqual(backedOut.kept, ["claude-peer"]);
	assert.deepEqual(s.read().agents.providers["claude-peer"], E, "their edit stands");
	rmSync(s.dir, { recursive: true, force: true });
}

// A competing write between the read and the write aborts, having written
// nothing. Produced by racing two real applyProviders calls, NOT by a timer:
// its single await is a dynamic import of an already-cached module, which
// settles as a microtask, so the timers phase is never reached inside the call
// and no setTimeout can interleave with it.
{
	const s = applySandbox("apply-conflict");
	writeFileSync(s.configPath, JSON.stringify({ agents: { providers: {} } }, null, 2), "utf8");

	// Both read the same `before`, then both suspend on that await; the first to
	// resume writes, and the second's re-read no longer matches what it read.
	// Deterministic, and it needs no seam in the production path.
	const [first, second] = await Promise.all([
		applyProviders(s.env),
		applyProviders(s.env),
	]);

	const outcomes = [first, second];
	const winner = outcomes.find((r) => r.ok);
	const loser = outcomes.find((r) => !r.ok);
	assert.ok(winner, "one of the two writes lands");
	assert.ok(loser, "the other is refused rather than clobbering it");
	assert.equal(loser.status, "conflict");
	assert.match(loser.error, /changed while this command was running/);

	// The winner's bytes are intact: the loser aborted BEFORE any write.
	const onDisk = s.read();
	for (const name of ROLE_PROVIDERS) assert.ok(name in onDisk.agents.providers);
	assert.equal(onDisk.agents.providers["claude-peer"].env.CLAUDE_CODE_ENABLE_CFC, "1");
	rmSync(s.dir, { recursive: true, force: true });
}

// Valid JSON of the wrong SHAPE is not a config. It must not be spread into an
// object, and the ledger must survive — it is the only record of what a --force
// replaced, so deleting it would strand the operator's original.
{
	for (const shape of ["[]", "42", '"x"', "true", "null"]) {
		const s = applySandbox("apply-shape");
		writeFileSync(s.configPath, shape, "utf8");
		const result = await applyProviders(s.env);
		assert.equal(result.ok, false, `${shape} is not a config`);
		assert.equal(result.status, "failed");
		assert.equal(readFileSync(s.configPath, "utf8"), shape, "bytes untouched");

		const ledgerPath = claudeProviderLedgerPath(s.env);
		writeFileSync(ledgerPath, JSON.stringify({ version: 1, providers: { "claude-peer": { mode: "replaced", wrote: {}, previous: { extends: "claude", label: "theirs" } } } }), "utf8");
		const backedOut = removeProviders(s.env);
		assert.equal(backedOut.ok, false, `${shape}: uninstall refuses too`);
		assert.equal(readFileSync(s.configPath, "utf8"), shape, "bytes untouched");
		assert.ok(existsSync(ledgerPath), `${shape}: the ledger is KEPT, or the restore data is gone`);
		rmSync(s.dir, { recursive: true, force: true });
	}
}

// --force must not strand a provider we generated in an older version. Plain
// apply retires it correctly; the destructive-consent flag was the one leaking.
{
	const s = applySandbox("apply-retired");
	await applyProviders(s.env);
	const ledgerPath = claudeProviderLedgerPath(s.env);
	const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
	const retired = { extends: "claude", label: "a role we no longer generate" };
	ledger.providers["claude-archivist"] = { mode: "created", wrote: retired };
	writeFileSync(ledgerPath, JSON.stringify(ledger), "utf8");
	const config = s.read();
	config.agents.providers["claude-archivist"] = retired;
	writeFileSync(s.configPath, JSON.stringify(config, null, 2), "utf8");

	const forced = await applyProviders(s.env, { force: true });
	assert.ok(forced.removed.includes("claude-archivist"), "reported as retired");
	assert.equal(
		s.read().agents.providers["claude-archivist"],
		undefined,
		"--force retires it instead of stranding it with no ownership record",
	);
	rmSync(s.dir, { recursive: true, force: true });
}

// Deleting every provider and re-running must not answer "already applied".
{
	const s = applySandbox("apply-absent");
	await applyProviders(s.env);
	const config = s.read();
	for (const name of ROLE_PROVIDERS) delete config.agents.providers[name];
	writeFileSync(s.configPath, JSON.stringify(config, null, 2), "utf8");

	const rerun = await applyProviders(s.env);
	assert.equal(rerun.status, "incomplete");
	assert.equal(rerun.ok, false, "zero of our providers on the host is not success");
	assert.deepEqual([...rerun.absent].sort(), ROLE_PROVIDERS);
	const text = applyNextSteps(rerun).join("\n");
	assert.match(text, /MISSING FROM THIS HOST/);
	assert.ok(!/already applied/i.test(text));
	rmSync(s.dir, { recursive: true, force: true });
}

// The operator has to be TOLD the change is inert, not just handed a command —
// and told that WHEN it activates is not entirely theirs to choose.
{
	const updated = applyNextSteps({ status: "updated" }).join("\n");
	assert.match(updated, /HAS NOT TAKEN EFFECT YET/);
	assert.match(updated, /already\s+running will NOT pick this up/);
	assert.match(updated, /reload/);

	// The unchanged branch must NOT claim there is nothing to reload: this
	// command cannot know whether a reload has happened since the write.
	const unchanged = applyNextSteps({ status: "unchanged" }).join("\n");
	assert.ok(!/nothing to reload/i.test(unchanged));
	assert.match(unchanged, /NOT the same as the change being live/);

	// A run can BOTH write and leave something absent: the operator deleted one
	// provider, and the other two need updating because the generated block
	// changed — the ordinary upgrade path. That branch returned early and carried
	// no activation warning at all, in the output it calls the most important to
	// read. The previous loop covered only two branches, so nothing caught it.
	const mixed = applyNextSteps({
		status: "incomplete",
		absent: ["claude-lead"],
		present: ["claude-peer", "claude-supervisor"],
		created: [],
		updated: ["claude-peer", "claude-supervisor"],
		removed: [],
	}).join("\n");
	assert.match(mixed, /MISSING FROM THIS HOST/);

	// Nothing of ours on the host and nothing written: there is genuinely no
	// pending change, and the warning would be noise.
	const nothingApplied = applyNextSteps({
		status: "incomplete",
		absent: ROLE_PROVIDERS,
		present: [],
		created: [],
		updated: [],
		removed: [],
	}).join("\n");
	assert.ok(!/reload OR RESTART/.test(nothingApplied), "no pending change to warn about");

	// Every branch that left something pending must carry the framing that a
	// restart nobody asked for will activate it. Asserted per branch so dropping
	// it from any one of them fails.
	for (const [label, text] of [["updated", updated], ["unchanged", unchanged], ["mixed", mixed]]) {
		assert.match(text, /reload OR RESTART/, `${label}: names restart as an activation path`);
		assert.match(text, /may not be under your control/, `${label}: says whose choice it is not`);
	}

	// Restart is never offered as a command to run. Asserted against the command
	// SPELLING rather than a line shape: the previous per-line check matched only
	// a bare indented invocation, so a run-prefixed inline one would have slipped
	// through while the claim being made was the broader "never offered". Prose
	// ABOUT restarting is deliberately still allowed — both branches say a
	// restart may happen without you — and only the invocation is banned.
	for (const [label, text] of [["updated", updated], ["unchanged", unchanged]]) {
		assert.ok(
			!/daemon\s+restart/i.test(text),
			`${label}: must never spell out the restart invocation`,
		);
	}
}

// --- Skills: the Claude Lead can finally load the procedure its prompt names --
//
// Before this, skills were copied only to ~/.pi/agent/skills/, which Claude
// Code does not read: `Skill(paseo-team-lead)` was allowed and found nothing.
{
	const skillsHome = mkdtempSync(join(tmpdir(), "paseo-claude-skills-"));
	const skillEnv = {
		...process.env,
		CLAUDE_CONFIG_DIR: join(skillsHome, ".claude"),
		PASEO_TEAM_CLAUDE_USER_CONFIG: join(skillsHome, ".claude.json"),
		PASEO_CONFIG_JSON: join(skillsHome, "paseo-config.json"),
		PST_TEAM_CONFIG_DIR: skillsHome,
	};
	const skillsDir = claudeSkillsDir(skillEnv);
	assert.equal(skillsDir, join(skillsHome, ".claude", "skills"));

	const shipped = packSkillSources().map((source) => source.name).sort();
	assert.deepEqual(shipped, ["paseo-ocr-reviewer", "paseo-team-lead"]);

	// Before install, verify must call this out — a Lead without its procedure
	// is an incomplete install, not a cosmetic gap.
	assert.deepEqual(missingSkills(skillEnv).sort(), shipped);

	const installed = installSkills(skillEnv);
	assert.equal(installed.status, "updated");
	for (const name of shipped) {
		assert.ok(
			existsSync(join(skillsDir, name, "SKILL.md")),
			`${name}/SKILL.md must land where Claude Code reads skills`,
		);
	}
	assert.deepEqual(missingSkills(skillEnv), []);

	// Re-install replaces the package rather than merging into it: a file from
	// an older release is a half-version of a procedure that reads as current.
	writeFileSync(join(skillsDir, "paseo-team-lead", "STALE.md"), "old");
	installSkills(skillEnv);
	assert.ok(!existsSync(join(skillsDir, "paseo-team-lead", "STALE.md")));

	// A skill the user owns under a DIFFERENT name is never touched. The
	// same-named case is the one that matters and it gets its own block below —
	// this assertion alone once stood for the broader claim, and the broader
	// claim was false.
	mkdirSync(join(skillsDir, "my-own-skill"), { recursive: true });
	writeFileSync(join(skillsDir, "my-own-skill", "SKILL.md"), "mine");
	installSkills(skillEnv);
	assert.ok(existsSync(join(skillsDir, "my-own-skill", "SKILL.md")));

	const removed = removeSkills(skillEnv);
	assert.equal(removed.status, "updated");
	assert.deepEqual(removed.skills.sort(), shipped);
	for (const name of shipped) assert.ok(!existsSync(join(skillsDir, name)));
	assert.ok(
		existsSync(join(skillsDir, "my-own-skill", "SKILL.md")),
		"uninstall removes only the packages this pack ships",
	);

	// Idempotent, and never creates the directory it was asked to clean.
	assert.equal(removeSkills(skillEnv).status, "unchanged");
	const neverInstalled = {
		...skillEnv,
		CLAUDE_CONFIG_DIR: join(skillsHome, "absent"),
	};
	assert.equal(removeSkills(neverInstalled).status, "missing");
	assert.ok(!existsSync(claudeSkillsDir(neverInstalled)));

	// verify reports a missing skill as missing, and stops once installed.
	assert.ok(verify(skillEnv).missing.some((item) => item.startsWith("skill:")));
	installSkills(skillEnv);
	assert.deepEqual(verify(skillEnv).missingSkills, []);

	rmSync(skillsHome, { recursive: true, force: true });
}

// --- A same-named skill the user wrote is theirs, not ours ------------------
//
// `~/.claude/skills/` is the user's directory and the names this pack ships are
// ordinary English. Whoever created `paseo-team-lead/` there first owns it, and
// nothing in a directory's contents says who that was: a user's own skill has a
// SKILL.md exactly like ours. Install used to rmSync the destination and
// uninstall used to delete anything with a SKILL.md in it, so both destroyed
// that work silently. The marker is the only thing that authorises a delete.
{
	const squatHome = mkdtempSync(join(tmpdir(), "paseo-claude-skill-squat-"));
	const squatEnv = {
		...process.env,
		CLAUDE_CONFIG_DIR: join(squatHome, ".claude"),
		PASEO_TEAM_CLAUDE_USER_CONFIG: join(squatHome, ".claude.json"),
		PASEO_CONFIG_JSON: join(squatHome, "paseo-config.json"),
		PST_TEAM_CONFIG_DIR: squatHome,
	};
	const skillsDir = claudeSkillsDir(squatEnv);
	const [taken, free] = packSkillSources()
		.map((source) => source.name)
		.sort();

	// The user got there first, under a name this pack also ships.
	mkdirSync(join(skillsDir, taken), { recursive: true });
	writeFileSync(join(skillsDir, taken, "SKILL.md"), "my own procedure");
	writeFileSync(join(skillsDir, taken, "notes.md"), "months of work");

	const installed = installSkills(squatEnv);

	// Install refuses that one by name and still does its job for the rest —
	// a name collision is not a reason to leave the other skills uninstalled.
	assert.equal(installed.status, "conflict");
	assert.deepEqual(installed.conflicts, [taken]);
	assert.deepEqual(installed.skills, [free]);
	assert.equal(
		readFileSync(join(skillsDir, taken, "SKILL.md"), "utf8"),
		"my own procedure",
		"install must not overwrite a same-named skill it did not create",
	);
	assert.ok(existsSync(join(skillsDir, taken, "notes.md")));
	assert.ok(skillIsOurs(join(skillsDir, free)));
	assert.ok(!skillIsOurs(join(skillsDir, taken)));

	// And it is reported missing, because it IS missing: the role prompt sends
	// the Lead to our procedure, and somebody else's file under that name is a
	// wrong answer rather than a present one.
	assert.deepEqual(missingSkills(squatEnv), [taken]);

	// Uninstall takes back only what it wrote.
	const removed = removeSkills(squatEnv);
	assert.deepEqual(removed.skills, [free]);
	assert.equal(
		readFileSync(join(skillsDir, taken, "SKILL.md"), "utf8"),
		"my own procedure",
		"uninstall must not delete a same-named skill this pack did not install",
	);
	assert.ok(!existsSync(join(skillsDir, free)));

	// An install from before the marker existed is still ours, proved by bytes:
	// its SKILL.md is the copy this release ships. Marker-only ownership would
	// have quietly stopped uninstalling the packages the pack itself put there
	// on every host that upgraded into this version.
	rmSync(join(skillsDir, taken), { recursive: true, force: true });
	rmSync(join(skillsDir, free), { recursive: true, force: true });
	const shippedLead = packSkillSources().find((source) => source.name === free);
	mkdirSync(join(skillsDir, free), { recursive: true });
	writeFileSync(
		join(skillsDir, free, "SKILL.md"),
		readFileSync(join(shippedLead.path, "SKILL.md")),
	);
	assert.ok(skillIsOurs(join(skillsDir, free)), "a byte-identical legacy install is ours");
	assert.deepEqual(removeSkills(squatEnv).skills, [free]);
	assert.ok(!existsSync(join(skillsDir, free)));

	// Edit one byte and it is the user's again — an edited procedure is exactly
	// the one worth not deleting.
	mkdirSync(join(skillsDir, free), { recursive: true });
	writeFileSync(join(skillsDir, free, "SKILL.md"), "installed by an older version");
	assert.deepEqual(installSkills(squatEnv).conflicts, [free]);
	assert.ok(
		!removeSkills(squatEnv).skills.includes(free),
		"a directory installed before the marker existed is not ours to delete",
	);
	assert.equal(
		readFileSync(join(skillsDir, free, "SKILL.md"), "utf8"),
		"installed by an older version",
	);

	// The marker is ours and must not be reported back to the user as drift.
	rmSync(join(skillsDir, free), { recursive: true, force: true });
	installSkills(squatEnv);
	assert.ok(existsSync(join(skillsDir, free, SKILL_OWNER_MARKER)));
	const drift = installDrift({ env: squatEnv });
	assert.ok(
		!drift.drift.some(
			(item) => item.kind === "claude-skill" && item.verdict === "unexpected",
		),
		"the ownership marker is not drift",
	);

	rmSync(squatHome, { recursive: true, force: true });
}

// --- the provider ledger lives where the rest of the pack's config does ------
//
// It used to resolve the directory itself, honouring only PST_TEAM_CONFIG_DIR,
// so on a PASEO_TEAM_HOME-only host the ledger landed outside the directory
// every other consumer now uses — and this ledger is what tells an uninstall
// which providers were ours to remove. A ledger nobody finds is providers
// nobody cleans up.
{
	const dirA = join(home, "cfg-a");
	const dirB = join(home, "cfg-b");
	assert.equal(
		claudeProviderLedgerPath({ PST_TEAM_CONFIG_DIR: dirA }),
		join(dirA, "claude-provider-ledger.json"),
	);
	assert.equal(
		claudeProviderLedgerPath({ PASEO_TEAM_HOME: dirB }),
		join(dirB, "claude-provider-ledger.json"),
		"the legacy alias must reach the same directory as everything else",
	);
	assert.equal(
		claudeProviderLedgerPath({ PST_TEAM_CONFIG_DIR: dirA, PASEO_TEAM_HOME: dirB }),
		join(dirA, "claude-provider-ledger.json"),
		"the documented name wins, exactly as it does in lib-common",
	);
	// Unconfigured, the ledger follows whatever teamConfigDir() resolves — which
	// is one of TWO names now, decided by whether this host carries the pack's
	// legacy directory. Pinning either literal makes the assertion fail for being
	// right: it passed on a developer machine holding ~/.paseo-pi-team and failed
	// on a clean CI runner, which is the exact asymmetry the resolver exists to
	// absorb. Assert the rule, and assert the delegation while here.
	assert.equal(
		claudeProviderLedgerPath({}),
		join(teamConfigDir({}), "claude-provider-ledger.json"),
		"the unconfigured ledger path delegates to the shared resolver",
	);
	assert.match(
		claudeProviderLedgerPath({}),
		/[\/\\]\.(paseo-team-orchestration|paseo-pi-team)[\/\\]claude-provider-ledger\.json$/,
		"and lands in the pack's config directory under one of its two names",
	);
	assert.equal(
		claudeProviderLedgerPath({}),
		join(homedir(), existsSync(join(homedir(), ".paseo-pi-team")) ? ".paseo-pi-team" : ".paseo-team-orchestration", "claude-provider-ledger.json"),
		"and which of the two is not a guess",
	);
}

rmSync(home, { recursive: true, force: true });
console.log("claude setup tests passed");
