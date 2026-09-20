// Tests for the helpers shared by the support scripts. These used to exist as
// six near-identical private copies; the behaviours pinned here are the ones
// that differed between those copies and are therefore easy to regress.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PASEO_CONVENTIONAL_ENTRIES,
  PASEO_ORCHESTRATION_PREFS,
  compareOcrVersions,
  findOnPath,
  isEntrypoint,
  orchestrationPreferencesNotice,
  parseOcrVersion,
  paseoHomeDir,
  resolveCmdEntry,
  resolvePaseoClientModule,
  resolvePaseoExec,
  searchPathDirs,
  splitCommandLine,
} from "../scripts/lib-common.mjs";

const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const isWindows = process.platform === "win32";

// --- splitCommandLine --------------------------------------------------------

// The regression this whole helper exists for: team-communication.mjs used
// `override.split(/\s+/)`, which shredded any quoted path containing spaces
// into separate argv elements and made the spawn fail with ENOENT.
assert.deepEqual(
  splitCommandLine('"C:\\Program Files\\paseo\\paseo.exe"').parts,
  ["C:\\Program Files\\paseo\\paseo.exe"],
  "a quoted path with spaces stays ONE argv element",
);
assert.deepEqual(
  splitCommandLine('node "C:\\Program Files\\p\\cli.js" --json').parts,
  ["node", "C:\\Program Files\\p\\cli.js", "--json"],
);
assert.deepEqual(splitCommandLine("'/usr/local/my paseo'").parts, [
  "/usr/local/my paseo",
]);
assert.deepEqual(splitCommandLine("  paseo   --json  ").parts, [
  "paseo",
  "--json",
]);
assert.deepEqual(splitCommandLine("").parts, []);

// Unterminated quotes are reported, never guessed at: the caller maps this
// onto its own error code instead of spawning something half-parsed.
assert.equal(splitCommandLine('"unclosed').unterminated, true);
assert.equal(splitCommandLine("'unclosed").unterminated, true);
assert.equal(splitCommandLine('"closed"').unterminated, false);

// Non-strings throw instead of coercing: String(undefined) would have produced
// the argv element "undefined" and spawned a nonsense binary.
assert.throws(() => splitCommandLine(undefined), TypeError);
assert.throws(() => splitCommandLine(["paseo"]), TypeError);

// --- searchPathDirs / findOnPath ---------------------------------------------

{
  const dirs = searchPathDirs({ PATH: ["a", "", "b"].join(delimiter) });
  assert.deepEqual(dirs, ["a", "b"], "empty PATH entries are dropped");
}

{
  // %APPDATA%\npm holds npm-installed shims and is often missing from a child
  // process's PATH; on Windows it must be searched, elsewhere ignored.
  const dirs = searchPathDirs({ PATH: "a", APPDATA: join("C:", "Users", "x", "AppData") });
  if (isWindows) {
    assert.deepEqual(dirs, ["a", join("C:", "Users", "x", "AppData", "npm")]);
  } else {
    assert.deepEqual(dirs, ["a"]);
  }
}

{
  // Directory-major scan: PATH order decides the winner, not the order of the
  // names. `second.exe` sits earlier on PATH than `first.exe`, so it wins even
  // though "first.exe" is listed first.
  const dirA = tmp("libcommon-path-a-");
  const dirB = tmp("libcommon-path-b-");
  writeFileSync(join(dirA, "second.exe"), "");
  writeFileSync(join(dirB, "first.exe"), "");
  const env = { PATH: [dirA, dirB].join(delimiter) };
  assert.equal(
    findOnPath(["first.exe", "second.exe"], env),
    join(dirA, "second.exe"),
    "earlier PATH dir wins over earlier name",
  );
  assert.equal(findOnPath("first.exe", env), join(dirB, "first.exe"), "accepts a bare string");
  assert.equal(findOnPath(["absent.exe"], env), undefined);
  assert.equal(findOnPath(["absent.exe"], { PATH: "" }), undefined, "empty PATH is not a crash");
}

// --- resolveCmdEntry ---------------------------------------------------------

{
  const shimDir = tmp("libcommon-shim-");
  const entryDir = join(shimDir, "node_modules", "@getpaseo", "cli", "dist");
  mkdirSync(entryDir, { recursive: true });
  const entry = join(entryDir, "index.js");
  writeFileSync(entry, "");

  // npm has emitted both %~dp0 and the older %dp0% form.
  for (const token of ["%~dp0", "%dp0%"]) {
    const shim = join(shimDir, `paseo-${token.replace(/[%~]/g, "")}.cmd`);
    writeFileSync(
      shim,
      `@IF EXIST "${token}\\node_modules\\@getpaseo\\cli\\dist\\index.js" (\n  "${token}\\node_modules\\@getpaseo\\cli\\dist\\index.js" %*\n)\n`,
    );
    assert.equal(resolveCmdEntry(shim), entry, `shim with ${token} resolves`);
  }

  // Unparseable shim → conventional layout beside it.
  const opaque = join(shimDir, "opaque.cmd");
  writeFileSync(opaque, "@echo off\r\nrem nothing quotable here\r\n");
  assert.equal(resolveCmdEntry(opaque), undefined, "no candidates → undefined");
  assert.equal(
    resolveCmdEntry(opaque, PASEO_CONVENTIONAL_ENTRIES),
    entry,
    "falls back to the conventional dist/index.js layout",
  );

  // A shim that points at a file which does not exist must not be trusted.
  const dangling = join(shimDir, "dangling.cmd");
  writeFileSync(dangling, `"%~dp0\\node_modules\\@getpaseo\\cli\\dist\\gone.js" %*\n`);
  assert.equal(resolveCmdEntry(dangling), undefined, "parsed entry must exist on disk");

  assert.equal(resolveCmdEntry(join(shimDir, "no-such-file.cmd")), undefined, "unreadable shim");
}

{
  // Second conventional layout: bin/paseo, shipped by other @getpaseo/cli
  // versions. Without it, team-communication's old resolution would regress.
  const shimDir = tmp("libcommon-shim-bin-");
  const binDir = join(shimDir, "node_modules", "@getpaseo", "cli", "bin");
  mkdirSync(binDir, { recursive: true });
  const entry = join(binDir, "paseo");
  writeFileSync(entry, "");
  const opaque = join(shimDir, "opaque.cmd");
  writeFileSync(opaque, "@echo off\r\n");
  assert.equal(resolveCmdEntry(opaque, PASEO_CONVENTIONAL_ENTRIES), entry);
}

// --- resolvePaseoExec --------------------------------------------------------

{
  const previous = process.env.PASEO_TEAM_PASEO_EXEC;
  const restore = () => {
    if (previous === undefined) delete process.env.PASEO_TEAM_PASEO_EXEC;
    else process.env.PASEO_TEAM_PASEO_EXEC = previous;
  };

  process.env.PASEO_TEAM_PASEO_EXEC = '"C:\\Program Files\\paseo\\paseo.exe" --json';
  assert.deepEqual(
    resolvePaseoExec(),
    ["C:\\Program Files\\paseo\\paseo.exe", "--json"],
    "override keeps a spaced path intact",
  );

  // A malformed override is a hard error, never a silent fall-through to a
  // bare "paseo" that would run a different binary than the operator asked for.
  const seen = [];
  const onInvalid = (reason) => {
    seen.push(reason);
    throw new Error(`mapped: ${reason}`);
  };
  process.env.PASEO_TEAM_PASEO_EXEC = '""';
  assert.throws(() => resolvePaseoExec(onInvalid), /mapped: is set but empty/);
  process.env.PASEO_TEAM_PASEO_EXEC = '"unclosed';
  assert.throws(() => resolvePaseoExec(onInvalid), /mapped: has an unterminated quote/);
  // Whitespace only. This is the value an operator actually produces — a
  // trailing space, a half-deleted line — and it used to resolve to a bare
  // "paseo", which on a host with a running daemon answers normally from a
  // binary nobody chose. Both spellings of blank must fail the same way.
  process.env.PASEO_TEAM_PASEO_EXEC = "   ";
  assert.throws(() => resolvePaseoExec(onInvalid), /mapped: is set but empty/);
  process.env.PASEO_TEAM_PASEO_EXEC = "";
  assert.throws(() => resolvePaseoExec(onInvalid), /mapped: is set but empty/);
  assert.deepEqual(seen, [
    "is set but empty",
    "has an unterminated quote",
    "is set but empty",
    "is set but empty",
  ]);

  // Without a mapper it still throws rather than returning something usable.
  assert.throws(() => resolvePaseoExec(), /PASEO_TEAM_PASEO_EXEC/);

  delete process.env.PASEO_TEAM_PASEO_EXEC;
  const resolved = resolvePaseoExec();
  assert.ok(Array.isArray(resolved) && resolved.length >= 1);
  if (!isWindows) {
    assert.deepEqual(resolved, ["paseo"], "non-Windows resolution is the bare name");
  }
  restore();
}

// --- isEntrypoint ------------------------------------------------------------

{
  const dir = tmp("libcommon-entry-");
  const target = join(dir, "module.mjs");
  writeFileSync(target, "export {};\n");
  const url = pathToFileURL(target).href;

  assert.equal(isEntrypoint(url, target), true);
  assert.equal(isEntrypoint(url, undefined), false, "no argv[1] → not an entrypoint");
  assert.equal(isEntrypoint(url, join(dir, "other.mjs")), false, "missing path → false, not a throw");

  // macOS temp dirs are reachable via both /var and /private/var, and installed
  // scripts are commonly symlinked: comparison must be on canonical paths.
  const link = join(dir, "link.mjs");
  try {
    symlinkSync(target, link, "file");
    assert.equal(isEntrypoint(url, link), true, "symlink alias resolves to the same module");
  } catch (error) {
    if (!isWindows) throw error; // Windows without developer mode cannot symlink
  }
}

// --- OCR version helpers -----------------------------------------------------

assert.equal(parseOcrVersion("open-code-review v1.8.10"), "1.8.10");
assert.equal(parseOcrVersion("open-code-review v1.9.2 (5b37b5f8e) windows/amd64"), "1.9.2");
assert.equal(parseOcrVersion("ocr unknown"), null);
assert.equal(parseOcrVersion(undefined), null, "non-string input is not a throw");

assert.equal(compareOcrVersions("1.8.10", "1.8.10"), 0);
assert.equal(compareOcrVersions("1.8.9", "1.8.10"), -1, "numeric compare, not lexicographic");
assert.equal(compareOcrVersions("1.10.0", "1.9.9"), 1);
assert.equal(compareOcrVersions("2", "1.9.9"), 1, "missing segments count as 0");

// --- routing source of truth (docs/multi-supervisor-topology.md §4.4) --------
// The pack routes ONLY from cluster-routing.local.json. Paseo's own
// orchestration-preferences.json is never read and never written; the notice
// exists so an operator who edits that file learns the pack ignored it,
// instead of wondering why the model never changed.

{
  const home = tmp("prefs-");
  const prefsPath = join(home, PASEO_ORCHESTRATION_PREFS);

  assert.equal(paseoHomeDir({ PASEO_HOME: home }), home, "PASEO_HOME wins");
  assert.equal(paseoHomeDir({ PASEO_HOME: "   " }).endsWith(".paseo"), true, "blank falls back");
  assert.equal(paseoHomeDir({}).endsWith(".paseo"), true, "documented default");

  assert.equal(
    orchestrationPreferencesNotice({ PASEO_HOME: home }),
    null,
    "absent is the common case and says nothing — reporting it would be noise",
  );

  writeFileSync(prefsPath, JSON.stringify({ impl: "some-provider" }));
  const notice = orchestrationPreferencesNotice({ PASEO_HOME: home });
  assert.ok(notice, "an existing preferences file must be surfaced");
  assert.equal(notice.path, prefsPath);
  assert.match(
    notice.message,
    /cluster-routing\.local\.json/,
    "the notice must name the file the pack DOES read, not just the one it ignores",
  );
  assert.match(notice.message, /does NOT read it/, "the decision has to be stated, not implied");

  // The helper must not read or parse Paseo's file — existence is the whole
  // question, so a corrupt or unreadable one still produces a clean notice.
  writeFileSync(prefsPath, "{ not json");
  assert.ok(
    orchestrationPreferencesNotice({ PASEO_HOME: home }),
    "a corrupt preferences file is still just a notice, never a throw",
  );
}

// --- one config directory, one resolver --------------------------------------
//
// The pack shipped TWO env var names for the same directory: config-walker
// honoured PST_TEAM_CONFIG_DIR while model-routing.mjs and claude-hook.mjs
// honoured PASEO_TEAM_HOME. An operator who set one got `pteam status`
// reporting the routing file present at the configured path while
// `pteam preflight` reported it MISSING and named a different one — same
// command family, same environment, two answers.
//
// It cannot be fixed by one side importing the other: config-walker is not
// shipped to the installed support directory, and the support scripts are not
// importable from the CLI's layer. lib-common is the only file both can reach,
// so the resolver lives there and everyone delegates — which is exactly what
// this asserts, because a delegation that gets quietly re-inlined is how the
// split came back.
{
	const { teamConfigDir } = await import("../scripts/lib-common.mjs");
	const cw = await import("../cli/lib/config-walker.mjs");
	const routing = await import("../scripts/model-routing.mjs");
	const hook = await import("../scripts/claude-hook.mjs");
	// Both of these used to name the directory by literal instead of asking.
	// lease-ledger was the worse of the two: a host that set the override moved
	// every pack file EXCEPT the lease board, and the board is the one file
	// whose entire job is to be the single place two writers meet.
	const lease = await import("../scripts/lease-ledger.mjs");
	const seats = await import("../scripts/seat-profiles.mjs");

	const prevPst = process.env.PST_TEAM_CONFIG_DIR;
	const prevHome = process.env.PASEO_TEAM_HOME;
	const set = (pst, teamHome) => {
		if (pst === null) delete process.env.PST_TEAM_CONFIG_DIR;
		else process.env.PST_TEAM_CONFIG_DIR = pst;
		if (teamHome === null) delete process.env.PASEO_TEAM_HOME;
		else process.env.PASEO_TEAM_HOME = teamHome;
	};
	try {
		for (const [pst, teamHome, expected, why] of [
			["/tmp/pst-a", null, "/tmp/pst-a", "the documented name is honoured"],
			[null, "/tmp/pst-b", "/tmp/pst-b", "the legacy name still works"],
			["/tmp/pst-a", "/tmp/pst-b", "/tmp/pst-a", "the documented name wins when both are set"],
		]) {
			set(pst, teamHome);
			assert.equal(teamConfigDir(), expected, why);
			// Every consumer must land on the same directory, or the two halves
			// of one command disagree again.
			assert.equal(cw.teamConfigDir(), expected, `config-walker: ${why}`);
			assert.equal(routing.defaultRoutingDir(), expected, `model-routing: ${why}`);
			assert.equal(hook.teamHome(process.env), expected, `claude-hook: ${why}`);
			assert.equal(lease.defaultLedgerPath(), join(expected, "lease-ledger.jsonl"), `lease-ledger: ${why}`);
			assert.equal(seats.defaultTeamDir(), expected, `seat-profiles: ${why}`);
			assert.equal(
				routing.defaultClusterRoutingPath(),
				join(expected, "cluster-routing.local.json"),
				`cluster path: ${why}`,
			);
		}
		// With neither set, all four fall back to the same default.
		set(null, null);
		const fallback = teamConfigDir();
		// Which of the two names that is depends on the host, so assert the
		// RULE rather than a literal: a developer machine carrying the legacy
		// directory and a clean CI runner must both be correct here, and
		// pinning either literal makes one of them fail for being right.
		assert.equal(
			fallback,
			existsSync(join(homedir(), ".paseo-pi-team"))
				? join(homedir(), ".paseo-pi-team")
				: join(homedir(), ".paseo-team-orchestration"),
			"the unconfigured default follows the legacy-directory rule",
		);
		assert.equal(cw.teamConfigDir(), fallback);
		assert.equal(routing.defaultRoutingDir(), fallback);
		assert.equal(hook.teamHome(process.env), fallback);
		assert.equal(lease.defaultLedgerPath(), join(fallback, "lease-ledger.jsonl"));
		assert.equal(seats.defaultTeamDir(), fallback);
		// A blank value is not a configured value.
		set("   ", null);
		assert.equal(teamConfigDir(), fallback, "whitespace is not a path");
	} finally {
		set(prevPst ?? null, prevHome ?? null);
	}
}

// --- the unconfigured default is two names, and which one is not a guess -----
//
// The pack was renamed. A host installed under the old name holds the only copy
// of its routing files, seat ledger, permit log and provider env — and systemd
// may be loading that env — so the legacy directory has to keep winning there
// forever. A host that never had one must NOT be handed the old name, or every
// machine installed from here on is born already wrong.
//
// `home` is injected rather than steered through $HOME because os.homedir()
// ignores $HOME on Windows, where this suite also runs.
{
	const { teamConfigDir } = await import("../scripts/lib-common.mjs");

	const withLegacy = mkdtempSync(join(tmpdir(), "pst-legacy-"));
	mkdirSync(join(withLegacy, ".paseo-pi-team"));
	const clean = mkdtempSync(join(tmpdir(), "pst-clean-"));

	assert.equal(
		teamConfigDir({}, clean),
		join(clean, ".paseo-team-orchestration"),
		"a host with no legacy directory gets the current name",
	);
	assert.equal(
		teamConfigDir({}, withLegacy),
		join(withLegacy, ".paseo-pi-team"),
		"an installed host keeps the directory that holds its state",
	);

	// Both present is not a tie to break by recency: the legacy one is the one
	// every other reader has been writing to, so it still wins.
	mkdirSync(join(withLegacy, ".paseo-team-orchestration"));
	assert.equal(
		teamConfigDir({}, withLegacy),
		join(withLegacy, ".paseo-pi-team"),
		"with both present the directory holding the state still wins",
	);

	// An explicit override outranks the probe entirely — otherwise a host that
	// pointed the pack somewhere else would silently get its state back home.
	assert.equal(
		teamConfigDir({ PST_TEAM_CONFIG_DIR: "/tmp/pst-explicit" }, withLegacy),
		"/tmp/pst-explicit",
		"the documented override beats an existing legacy directory",
	);
	assert.equal(
		teamConfigDir({ PASEO_TEAM_HOME: "/tmp/pst-legacy-env" }, withLegacy),
		"/tmp/pst-legacy-env",
		"the legacy alias beats an existing legacy directory too",
	);
	assert.equal(
		teamConfigDir({ PST_TEAM_CONFIG_DIR: "   " }, clean),
		join(clean, ".paseo-team-orchestration"),
		"whitespace is not a configured value here either",
	);
}

// --- Paseo's own home is one answer too --------------------------------------
//
// `paseoHome()` honoured Paseo's documented PASEO_HOME while
// `paseoConfigPath()` did not, so a machine that moved its daemon home had the
// pack reading agent STATE from the new tree and the daemon CONFIG from the old
// one — and preflight could pass `paseo-browser-tools` on a host whose real
// config has the browser disabled.
{
	const cw = await import("../cli/lib/config-walker.mjs");
	const prevHome = process.env.PASEO_HOME;
	const prevJson = process.env.PASEO_CONFIG_JSON;
	try {
		delete process.env.PASEO_CONFIG_JSON;
		process.env.PASEO_HOME = "/tmp/paseo-elsewhere";
		assert.equal(cw.paseoHome(), "/tmp/paseo-elsewhere");
		assert.equal(
			cw.paseoConfigPath(),
			join("/tmp/paseo-elsewhere", "config.json"),
			"the config must come from the same tree as the state",
		);
		assert.equal(cw.paseoAgentsDir(), join("/tmp/paseo-elsewhere", "agents"));

		// The explicit file override still wins — it is the narrower statement.
		process.env.PASEO_CONFIG_JSON = "/tmp/exact-config.json";
		assert.equal(cw.paseoConfigPath(), "/tmp/exact-config.json");

		delete process.env.PASEO_HOME;
		delete process.env.PASEO_CONFIG_JSON;
		assert.match(cw.paseoConfigPath(), /\.paseo[\/\\]config\.json$/);
	} finally {
		if (prevHome === undefined) delete process.env.PASEO_HOME;
		else process.env.PASEO_HOME = prevHome;
		if (prevJson === undefined) delete process.env.PASEO_CONFIG_JSON;
		else process.env.PASEO_CONFIG_JSON = prevJson;
	}
}

// --- locating Paseo's client SDK ------------------------------------------
// `pteam models refresh` imports the module the paseo CLI itself imports, so
// the path is derived from wherever `paseo` really lives. The Windows case is
// the one that bites: what is on PATH there is an npm .cmd shim that lives
// nowhere near the package, so walking up from it lands outside @getpaseo/cli.
{
  const sandbox = mkdtempSync(join(tmpdir(), "pst-client-"));
  const binDir = join(sandbox, "bin");
  const pkgRoot = join(binDir, "node_modules", "@getpaseo", "cli");
  mkdirSync(join(pkgRoot, "dist", "utils"), { recursive: true });
  writeFileSync(join(pkgRoot, "dist", "index.js"), "// entry\n");
  const client = join(pkgRoot, "dist", "utils", "client.js");
  writeFileSync(client, "export function connectToDaemon() {}\n");

  const realPath = process.env.PATH;
  const realOverride = process.env.PASEO_TEAM_PASEO_CLIENT;
  delete process.env.PASEO_TEAM_PASEO_CLIENT;
  try {
    // An npm-generated shim: the entry it runs is the only pointer back to
    // the package, and it is written with %~dp0 and backslashes.
    writeFileSync(
      join(binDir, "paseo.cmd"),
      '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe" "%~dp0\\node_modules\\@getpaseo\\cli\\dist\\index.js" %*\r\n)\r\n',
    );
    process.env.PATH = binDir;
    // Compare real paths on both sides: the resolver realpaths what it found,
    // and on macOS the temp dir sits behind a symlink (/var -> /private/var),
    // so the literal strings differ while pointing at the same file.
    assert.equal(
      realpathSync(fileURLToPath(resolvePaseoClientModule())),
      realpathSync(client),
      "a .cmd shim must be read for its JS entry before the package root is derived",
    );

    // The override wins over everything, which is also how the tests inject a
    // fake daemon.
    process.env.PASEO_TEAM_PASEO_CLIENT = client;
    assert.equal(resolvePaseoClientModule(), pathToFileURL(client).href);
    delete process.env.PASEO_TEAM_PASEO_CLIENT;

    // Nothing on PATH and nothing beside the cwd: a configuration fault with
    // the places it looked, not a crash.
    process.env.PATH = join(sandbox, "empty");
    let reported = null;
    assert.throws(
      () => resolvePaseoClientModule((reason, tried) => { reported = { reason, tried }; throw new Error(reason); }),
      /could not find the paseo CLI/,
    );
    assert.ok(Array.isArray(reported.tried), "the failure names what it tried");
  } finally {
    process.env.PATH = realPath;
    if (realOverride === undefined) delete process.env.PASEO_TEAM_PASEO_CLIENT;
    else process.env.PASEO_TEAM_PASEO_CLIENT = realOverride;
  }
}

console.log("lib-common tests passed");
