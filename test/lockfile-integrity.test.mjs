import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// `npm ci` trusts package-lock.json: an entry without `integrity` is installed
// without checking the tarball against a hash, and an entry whose `resolved`
// points off the npm registry fetches code from somewhere the lock never
// vouched for. Nothing checked the lock, so either could slip in unnoticed.
// This runs with the rest of `npm test`, so CI covers it.
//
// One known exception. A package that ships its own npm-shrinkwrap.json
// (`hasShrinkwrap`) has its whole subtree REPLACED by that shrinkwrap when npm
// extracts it, so the hashes of its nested packages are whatever the shrinkwrap
// holds. pi-coding-agent's shrinkwrap carries none for pi-agent-core, pi-ai and
// pi-tui, and a hash added to the lock by hand is ignored by `npm ci` (a wrong
// one still installs) and stripped again by the next `npm install`. That gap
// can only be closed upstream, so those nested entries are exempt from the
// hash requirement, but only when they are dev-only and still must resolve over
// https from the registry.
const SRI = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const entries = Object.entries(lock.packages ?? {}).filter(([path, entry]) => path !== "" && !entry.link);
assert.ok(entries.length > 0, "the lockfile lists packages");

const shrinkwrapRoots = entries.filter(([, entry]) => entry.hasShrinkwrap).map(([path]) => `${path}/node_modules/`);
const underShrinkwrap = (path) => shrinkwrapRoots.some((root) => path.startsWith(root));

const missing = entries.filter(([path, entry]) => !underShrinkwrap(path) && !SRI.test(entry.integrity ?? ""));
assert.deepEqual(
	missing.map(([path]) => path),
	[],
	"every locked package carries a sha512 integrity hash (restore a stripped one from `npm view <pkg>@<version> dist.integrity`)",
);

const exemptRuntime = entries.filter(([path, entry]) => underShrinkwrap(path) && !SRI.test(entry.integrity ?? "") && !entry.dev);
assert.deepEqual(
	exemptRuntime.map(([path]) => path),
	[],
	"the shrinkwrap exemption covers dev-only packages; a runtime dependency without a hash must not hide behind it",
);

const offRegistry = entries.filter(([, entry]) => entry.resolved && !entry.resolved.startsWith("https://registry.npmjs.org/"));
assert.deepEqual(
	offRegistry.map(([path, entry]) => `${path} -> ${entry.resolved}`),
	[],
	"every locked package resolves over https from registry.npmjs.org (no git, http, file or credential-bearing URLs)",
);

const withCredentials = entries.filter(([, entry]) => /\/\/[^/]*@/.test(entry.resolved ?? ""));
assert.deepEqual(withCredentials.map(([path]) => path), [], "no resolved URL embeds userinfo");

console.log("lockfile-integrity tests passed");
