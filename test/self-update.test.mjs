import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	compareVersions,
	currentVersion,
	detectInstallMode,
	npmExec,
	pickLatestTag,
	repoSlug,
} from "../cli/lib/self-update.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

// --- compareVersions --------------------------------------------------------
assert.equal(compareVersions("1.2.3", "1.10.0"), -1, "numeric compare, not lexical");
assert.equal(compareVersions("1.10.0", "1.2.3"), 1);
assert.equal(compareVersions("v1.2.3", "1.2.3"), 0, "leading v is tolerated");
assert.equal(compareVersions("1.0", "1.0.0"), 0, "missing parts count as 0");
assert.equal(compareVersions("2.0.0", "1.99.99"), 1);

// --- pickLatestTag -----------------------------------------------------------
const lsRemote = [
	"0123456789abcdef0123456789abcdef01234567\trefs/tags/v0.9.0",
	"0123456789abcdef0123456789abcdef01234568\trefs/tags/v1.10.0",
	"0123456789abcdef0123456789abcdef01234569\trefs/tags/v1.9.0",
	"0123456789abcdef0123456789abcdef0123456a\trefs/tags/nightly",
	"0123456789abcdef0123456789abcdef0123456b\trefs/tags/release-2026",
].join("\n");
assert.equal(pickLatestTag(lsRemote), "v1.10.0", "highest release tag wins, non-semver ignored");
assert.equal(pickLatestTag(""), null, "no tags at all");
assert.equal(pickLatestTag("sha\trefs/tags/nightly"), null, "only non-release tags -> null");

// --- repoSlug ----------------------------------------------------------------
assert.equal(repoSlug({ repository: { url: "github:Minnyat/paseo-team-orchestration" } }), "Minnyat/paseo-team-orchestration");
assert.equal(repoSlug({ repository: { url: "git+https://github.com/a/b.git" } }), "a/b");
assert.equal(repoSlug({ repository: { url: "https://github.com/a/b" } }), "a/b");
assert.equal(repoSlug({ repository: { url: "git@github.com:a/b.git" } }), "a/b");
assert.throws(() => repoSlug({}), /repository\.url/);

// --- version truth -----------------------------------------------------------
assert.equal(currentVersion(), PKG.version, "currentVersion reads package.json, the single source");
assert.equal(detectInstallMode(), "checkout", "the test run lives inside the repo checkout");

// --- npmExec (Windows .cmd shims cannot be spawned with argv) -----------------
if (process.platform === "win32") {
	const [npmBin, ...npmPrefix] = npmExec();
	assert.equal(npmBin, process.execPath, "npm is driven through node itself, not the .cmd shim");
	const npmEntry = join(...npmPrefix);
	assert.ok(/npm-cli\.js$/.test(npmEntry), `resolves the real npm entry, got '${npmEntry}'`);
	assert.ok(existsSync(npmEntry), "the resolved npm-cli.js actually exists on this machine");
} else {
	assert.deepEqual(npmExec(), ["npm"], "non-Windows spawns npm directly");
}

console.log("self-update tests passed");
