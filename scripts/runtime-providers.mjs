// runtime-providers.mjs — Paseo provider entries for the Peer-only runtimes.
//
// pi and Claude ship their own installers (the pi extension; claude-setup.mjs
// for hooks + disallowedTools). Every other family in RUNTIME_DESCRIPTORS is a
// coding agent Paseo already drives AND lets a custom provider extend
// (PASEO_EXTENDABLE_BASES: opencode today; codex/copilot are candidates) and
// needs only a provider entry "<family>-<role>" that `extends` it. This module builds
// those entries FROM THE DESCRIPTORS, so teaching the pack a new runtime is one
// descriptor entry (+ its policy-core mirror) and, when the runtime has a
// permission system, one `staticPolicy` builder below — nothing else.
//
// `pteam runtimes apply` merges the result into ~/.paseo/config.json with its
// own ledger (runtime-providers.json), using the same ownership rule as seats:
// a provider this tool did not create is never overwritten.
import { join } from "node:path";
import {
	RUNTIME_DESCRIPTORS,
	RUNTIME_FAMILIES,
	runtimeDescriptor,
} from "./model-routing.mjs";

export const RUNTIME_LEDGER_FILE = "runtime-providers.json";

export function runtimeLedgerPath(teamConfigDir) {
	return join(teamConfigDir, RUNTIME_LEDGER_FILE);
}

/** Families whose providers this module generates (everything not "full"). */
export function generatedFamilies() {
	return RUNTIME_FAMILIES.filter((family) => RUNTIME_DESCRIPTORS[family].enforcement !== "full");
}

/**
 * The bash commands a Peer seat without per-turn policy is never allowed to
 * run. The full-enforcement runtimes grant commit/push per brief; a static
 * config cannot read a brief, so the safe constant is "never": that seat's
 * work is committed by a pi/Claude Peer or the Lead after review. `paseo` and
 * `pteam` are denied whole because a Peer coordinates only through its Lead.
 * Patterns are OpenCode's wildcard syntax; the last matching rule wins, so the
 * catch-all comes first. A heuristic, like every bash rule in this pack.
 */
export const STATIC_PEER_BASH_DENY = Object.freeze([
	"git commit*",
	"git push*",
	"git merge*",
	"git rebase*",
	"git reset --hard*",
	"git checkout -- *",
	"git clean*",
	"git branch -D*",
	"git tag*",
	"git -C * commit*",
	"git -C * push*",
	"paseo*",
	"pteam*",
	"paseo-team*",
	"npx paseo*",
	"npx pteam*",
]);

/**
 * Per-family builders of the runtime's OWN permission config, keyed by family.
 * A family with `enforcement: "static"` must have one (a test locks it).
 * Returns the env the provider entry carries.
 */
const STATIC_POLICY_BUILDERS = Object.freeze({
	opencode({ role, promptPath }) {
		const bash = { "*": "allow" };
		for (const pattern of STATIC_PEER_BASH_DENY) bash[pattern] = "deny";
		const config = {
			// The role prompt, loaded as an instruction file by OpenCode itself.
			...(promptPath ? { instructions: [promptPath] } : {}),
			permission: {
				edit: "allow",
				bash,
				// Same default as a Claude Peer (WebFetch/WebSearch disallowed).
				webfetch: "deny",
				// OpenCode's ask-the-user tool: a Peer's chain is Peer → Lead, never
				// the Human (AskUserQuestion is denied to Peers on both runtimes).
				question: "deny",
			},
		};
		// Paseo merges its bridge plugin into this JSON (opencode/bridge.js
		// decorateServerEnv keeps every other key), so the policy survives.
		return { PASEO_PI_ROLE: role, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
	},
});

export function hasStaticPolicyBuilder(family) {
	return Object.hasOwn(STATIC_POLICY_BUILDERS, family);
}

/**
 * One provider entry for (family, role). `promptsDir` is where the installed
 * role prompts live (config-walker promptsDir()); a missing dir just omits the
 * instruction file.
 */
export function runtimeProviderEntry(family, role, { promptsDir } = {}) {
	const d = runtimeDescriptor(family);
	if (!d) throw new Error(`unknown runtime family "${family}"`);
	if (!d.roles.includes(role)) {
		throw new Error(`${family} carries only ${d.roles.join(", ")} — "${family}-${role}" is not a role provider`);
	}
	if (d.enforcement === "full") {
		throw new Error(`${family} has its own installer (enforcement "full"); this module generates only peer-only runtimes`);
	}
	const promptPath = promptsDir ? join(promptsDir, `${role}.md`) : null;
	// Fail closed: a runtime is never seated with nothing but its prompt.
	const build = STATIC_POLICY_BUILDERS[family];
	if (!build) throw new Error(`${family} declares enforcement "static" but has no permission builder in runtime-providers.mjs`);
	return {
		extends: d.paseoBase,
		label: `${d.label} ${role[0].toUpperCase()}${role.slice(1)}`,
		env: build({ role, promptPath }),
	};
}

/** Every generated provider, or only those of `families`. */
export function materializeRuntimeProviders({ families, promptsDir } = {}) {
	const wanted = families && families.length > 0 ? families : generatedFamilies();
	const out = {};
	for (const family of wanted) {
		const d = runtimeDescriptor(family);
		if (!d) throw new Error(`unknown runtime family "${family}" (known: ${RUNTIME_FAMILIES.join(", ")})`);
		if (d.enforcement === "full") continue;
		for (const role of d.roles) out[`${family}-${role}`] = runtimeProviderEntry(family, role, { promptsDir });
	}
	return out;
}

/** The operator-facing table `pteam runtimes list` prints. */
export function describeRuntimes({ installedCli = () => null, configuredProviders = {} } = {}) {
	return RUNTIME_FAMILIES.map((family) => {
		const d = RUNTIME_DESCRIPTORS[family];
		const providers = d.roles.map((role) => `${family}-${role}`);
		return {
			family,
			label: d.label,
			cli: d.cli,
			cliVersion: installedCli(d.cli),
			paseoBase: d.paseoBase,
			enforcement: d.enforcement,
			roles: [...d.roles],
			providers,
			configured: providers.filter((name) => configuredProviders[name] !== undefined),
			modelShape: d.model.hint,
			thinkingLevels: [...d.thinkingLevels],
			setup:
				d.enforcement === "full"
					? "scripts/install.{sh,ps1} (+ claude-setup for Claude)"
					: `pteam runtimes apply --family ${family}`,
		};
	});
}
