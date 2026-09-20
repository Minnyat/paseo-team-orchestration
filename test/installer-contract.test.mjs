// Installer contract checks: installed support scripts must be usable from an
// unrelated project cwd and must include remote-paseo dependencies.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule as isRemoteMain } from "../scripts/remote-paseo.mjs";
import { isMainModule as isRoutingMain } from "../scripts/model-routing.mjs";
import { isMainModule as isOcrMain } from "../scripts/ocr-setup.mjs";
import { isMainModule as isOcrReviewMain } from "../scripts/ocr-review.mjs";
import { isMainModule as isCommunicationMain } from "../scripts/team-communication.mjs";
import { isMainModule as isLeaseMain } from "../scripts/team-lease.mjs";
import { isMainModule as isWatchdogMain } from "../scripts/watchdog.mjs";
import { isMainModule as isPathMain } from "../scripts/team-scripts-path.mjs";
import { defaultTeamScriptsDir, resolveTeamScriptsDir } from "../scripts/team-scripts-path.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "scripts");
const installed = mkdtempSync(join(tmpdir(), "paseo-installed-support-"));
const unrelatedCwd = mkdtempSync(join(tmpdir(), "paseo-unrelated-cwd-"));
for (const file of ["lib-common.mjs", "remote-paseo.mjs", "model-routing.mjs", "reliability.mjs", "team-communication.mjs", "team-lease.mjs", "lease-ledger.mjs", "watchdog.mjs", "ocr-review.mjs", "ocr-setup.mjs", "team-scripts-path.mjs"]) {
  cpSync(join(source, file), join(installed, file));
}

// Every file the installers ship must exist in scripts/, and every support
// script an installed file imports must itself be shipped — otherwise the
// install succeeds and then fails at import time on the user's machine.
for (const installer of ["install.sh", "install.ps1"]) {
  const text = readFileSync(join(root, "scripts", installer), "utf8");
  const shipped = new Set([...text.matchAll(/^\s*"?([a-z0-9-]+\.mjs)"?,?\s*$/gm)].map((m) => m[1]));
  // Sanity floor only — proves the regex still matches the installer's list
  // shape. The real check is the dependency loop below, not this count.
  assert.ok(shipped.size >= 4, `${installer}: support-file list not found (${shipped.size} matches)`);
  for (const file of shipped) {
    assert.ok(existsSync(join(source, file)), `${installer} ships missing scripts/${file}`);
    const body = readFileSync(join(source, file), "utf8");
    for (const [, dep] of body.matchAll(/from "\.\/([a-z0-9-]+\.mjs)"/g)) {
      assert.ok(shipped.has(dep), `${installer}: ${file} imports ./${dep}, which is not shipped`);
    }
  }
}

// The installers must CREATE and ADVERTISE the same config directory every
// reader resolves. Advertising $HOME/.paseo-pi-team unconditionally names a
// directory no reader uses on a host with PST_TEAM_CONFIG_DIR or the
// PASEO_TEAM_HOME alias set — the mirror image of the bug preflight had, where
// the reader looked somewhere the installer never wrote.
//
// The shell line is EXECUTED rather than pattern-matched: a test that only
// checks the file mentions both variable names passes on an installer whose
// comment mentions them and whose code ignores them, which is exactly what the
// first version of this check did.
{
  const sh = readFileSync(join(root, "scripts", "install.sh"), "utf8");
  // Extract the whole ladder, not one line. The resolver is four rungs across
  // an if/elif/else block now, and grabbing a single `TEAM_CONFIG_DIR=` line
  // would capture the first rung and then "verify" a resolver whose other
  // three branches never ran.
  const assignment = /^if \[ -n "\$\{PST_TEAM_CONFIG_DIR[\s\S]*?^fi$/m.exec(sh)?.[0];
  assert.ok(assignment, "install.sh must resolve the config dir into TEAM_CONFIG_DIR");
  // Executed on POSIX only. install.sh is the POSIX installer — Windows runs
  // install.ps1 — and the env below is replaced rather than merged so the
  // variables under test are the only ones set, which leaves no PATH for
  // Windows to resolve `bash` through. The shape check on install.ps1 below is
  // the cross-platform half.
  const runnable = process.platform !== "win32";
  const resolve = (vars, home = "/home/fake") =>
    execFileSync("bash", ["-c", `${assignment}; printf %s "$TEAM_CONFIG_DIR"`], {
      encoding: "utf8",
      env: { HOME: home, PST_TEAM_CONFIG_DIR: "", PASEO_TEAM_HOME: "", ...vars },
    });
  if (!runnable) {
    // Still assert the assignment references both names, so a Windows-only run
    // is not a run that checks nothing.
    assert.match(assignment, /PST_TEAM_CONFIG_DIR/);
    assert.match(assignment, /PASEO_TEAM_HOME/);
  } else {
  assert.equal(resolve({ PST_TEAM_CONFIG_DIR: "/srv/team" }), "/srv/team");
  assert.equal(resolve({ PASEO_TEAM_HOME: "/srv/legacy" }), "/srv/legacy", "the alias still works");
  assert.equal(
    resolve({ PST_TEAM_CONFIG_DIR: "/srv/team", PASEO_TEAM_HOME: "/srv/legacy" }),
    "/srv/team",
    "the documented name wins, exactly as it does in lib-common",
  );
  // The unconfigured rungs, against real directories: the probe is a `-d` test,
  // so a fake HOME that does not exist can only ever prove one of the two.
  const clean = mkdtempSync(join(tmpdir(), "install-sh-clean-"));
  const legacy = mkdtempSync(join(tmpdir(), "install-sh-legacy-"));
  mkdirSync(join(legacy, ".paseo-pi-team"));
  assert.equal(
    resolve({}, clean),
    join(clean, ".paseo-team-orchestration"),
    "a new host is installed under the current name",
  );
  assert.equal(
    resolve({}, legacy),
    join(legacy, ".paseo-pi-team"),
    "a host already installed under the old name keeps its state",
  );
  // Same four rungs, same order, as teamConfigDir() in lib-common. A shell
  // ladder that drifts from the JS one installs into a directory the readers
  // never look at, which is this whole block's reason to exist.
  assert.equal(
    resolve({ PST_TEAM_CONFIG_DIR: "/srv/team" }, legacy),
    "/srv/team",
    "the documented override still beats an existing legacy directory",
  );
  }

  // Whatever it resolved is what gets created and advertised — not a literal.
  assert.match(sh, /mkdir -p "\$TEAM_CONFIG_DIR"/);
  assert.doesNotMatch(sh, /~\/\.paseo-pi-team\//, "advertises a path the readers may not use");
}
{
  // PowerShell is not on every runner, so this half stays shape-based — but it
  // is the ASSIGNMENT that is checked, not a mention anywhere in the file.
  const ps = readFileSync(join(root, "scripts", "install.ps1"), "utf8");
  const assignment = /\$teamConfigDir\s*=[\s\S]*?\n\n/.exec(ps)?.[0] ?? "";
  assert.match(assignment, /\$env:PST_TEAM_CONFIG_DIR/, "install.ps1: honours the documented override");
  assert.match(assignment, /\$env:PASEO_TEAM_HOME/, "install.ps1: honours the legacy alias");
  assert.match(assignment, /Test-Path \$teamLegacyDir/, "install.ps1: probes for the legacy directory");
  assert.match(assignment, /\.paseo-team-orchestration/, "install.ps1: defaults to the current name");
  assert.match(ps, /-Path \$teamConfigDir/, "install.ps1: creates what it resolved");
  assert.doesNotMatch(ps, /~\/\.paseo-pi-team\//);
}

const env = { ...process.env, PASEO_TEAM_SCRIPTS_DIR: installed };
assert.equal(resolveTeamScriptsDir({ PASEO_TEAM_SCRIPTS_DIR: installed }), installed);
assert.equal(
  defaultTeamScriptsDir({ PI_CODING_AGENT_DIR: "/custom/pi/agent" }),
  join("/custom/pi/agent", "extensions", "paseo-team-scripts"),
);
assert.equal(
  defaultTeamScriptsDir({ PI_HOME: "/custom/pi" }),
  join("/custom/pi", "agent", "extensions", "paseo-team-scripts"),
);
const installedRemotePath = join(installed, "remote-paseo.mjs");
assert.equal(env.PASEO_TEAM_SCRIPTS_DIR, installed);
const output = execFileSync(process.execPath, [installedRemotePath, "--help"], {
  cwd: unrelatedCwd,
  env: { ...env, PASEO_TEAM_HOME: join(unrelatedCwd, "config") },
  encoding: "utf8",
});
assert.match(output, /remote-paseo\.mjs/);

// macOS temporary directories may be addressed through /var or /private/var.
// Entrypoint detection must compare canonical filesystem paths, not URL text.
const symlinkCases = [
  [join(installed, "remote-paseo.mjs"), isRemoteMain],
  [join(installed, "model-routing.mjs"), isRoutingMain],
  [join(installed, "ocr-setup.mjs"), isOcrMain],
  [join(installed, "ocr-review.mjs"), isOcrReviewMain],
  [join(installed, "team-communication.mjs"), isCommunicationMain],
  [join(installed, "team-lease.mjs"), isLeaseMain],
  [join(installed, "watchdog.mjs"), isWatchdogMain],
  [join(installed, "team-scripts-path.mjs"), isPathMain],
];
for (const [target, isMain] of symlinkCases) {
  const link = join(installed, `link-${target.split(/[\\\\/]/).pop()}`);
  try {
    symlinkSync(target, link, "file");
  } catch (error) {
    if (process.platform !== "win32") throw error;
    continue;
  }
  assert.equal(
    isMain(link, pathToFileURL(target).href),
    true,
    `symlink entrypoint should resolve: ${target}`,
  );
  if (target.endsWith("remote-paseo.mjs")) {
    const symlinkOutput = execFileSync(process.execPath, [link, "--help"], {
      cwd: unrelatedCwd,
      env: { ...env, PASEO_TEAM_HOME: join(unrelatedCwd, "config") },
      encoding: "utf8",
    });
    assert.match(symlinkOutput, /remote-paseo\.mjs/);
  }
  if (target.endsWith("ocr-review.mjs")) {
    const symlinkOutput = execFileSync(process.execPath, [link, "--help"], {
      cwd: unrelatedCwd,
      env,
      encoding: "utf8",
    });
    assert.match(symlinkOutput, /ocr-review\.mjs/);
  }
  if (target.endsWith("team-scripts-path.mjs")) {
    const resolvedOutput = execFileSync(process.execPath, [link], {
      cwd: unrelatedCwd,
      env: { ...env, PI_CODING_AGENT_DIR: "/canonical/pi/agent" },
      encoding: "utf8",
    });
    assert.equal(resolvedOutput.trim(), installed);
  }
}

const installedRemote = readFileSync(join(installed, "remote-paseo.mjs"), "utf8");
assert.match(installedRemote, /from "\.\/model-routing\.mjs"/);
assert.match(installedRemote, /from "\.\/reliability\.mjs"/);

// --- Claude runtime: shipped files + installed-layout resolution ---------------
//
// The Claude hook resolves its policy modules RELATIVELY at runtime, and the
// installed layout differs from the checkout by one directory level. The
// import-scanning loop above cannot see a dynamic import, so the contract is
// proven by running the hook in a replica of the installed tree.
for (const installer of ["install.sh", "install.ps1"]) {
  const text = readFileSync(join(root, "scripts", installer), "utf8");
  for (const file of ["claude-hook.mjs", "claude-team-mcp.mjs", "paseo-team-core"]) {
    assert.ok(text.includes(file), `${installer} must ship ${file}`);
  }
  // The built .js must NOT reach the installed core. It exists only so an
  // installed npm package can load a core Node will not type-strip under
  // node_modules; the pi extension directory is not under node_modules, so the
  // .ts loads there. Shipping both installs two answers to one question, and
  // every loader prefers .js — a tree built once and edited since would have pi
  // read the CURRENT .ts while the Claude hook and pteam read the STALE .js.
  assert.match(
    text,
    /(rm -f "\$EXT_DIR\/\$POLICY_CORE_DIR"\/\*\.js|Filter \*\.js -File)/,
    `${installer} must delete the generated *.js from the installed policy core`,
  );
}

{
  const extDir = mkdtempSync(join(tmpdir(), "paseo-installed-ext-"));
  const scriptsDir = join(extDir, "paseo-team-scripts");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(extDir, "prompts"), { recursive: true });
  // The WHOLE core directory, exactly as `cp -R` / `Copy-Item -Recurse` ships
  // it. Naming individual files here would let a new core module pass CI while
  // being absent from every installed tree — which is precisely the failure the
  // module split was supposed to make impossible.
  cpSync(join(root, "extensions", "paseo-team-core"), join(extDir, "paseo-team-core"), {
    recursive: true,
  });
  // ...then strip the built .js exactly as the installers do, so this replica
  // exercises the .ts the installed hook actually loads. Without this the
  // replica would prove the BUILT core resolves and say nothing about the one
  // on a user's disk.
  for (const stale of readdirSync(join(extDir, "paseo-team-core"))) {
    if (stale.endsWith(".js")) rmSync(join(extDir, "paseo-team-core", stale));
  }
  assert.ok(
    existsSync(join(extDir, "paseo-team-core", "policy-core.ts")),
    "the installed core keeps its .ts source",
  );
  for (const file of [
    "claude-hook.mjs",
    "claude-team-mcp.mjs",
    "lib-common.mjs",
    // Every support script that reaches into the policy core. The two layouts
    // differ by one directory level, so a static "../extensions/..." specifier
    // is right in a checkout and wrong here — and it fails at IMPORT time,
    // where the caller reports it as something else entirely (a Lead unable to
    // staff any writer, blamed on an unreadable lease ledger).
    "team-lease.mjs",
    // Not a core-toucher itself — it is the board team-lease.mjs writes to, and
    // a dependency travels with the script that imports it or the import fails
    // in exactly the confusing way described above.
    "lease-ledger.mjs",
    "team-fork.mjs",
    // remote-paseo.mjs joined this list when its `run` command started
    // resolving policy-core (§PR-G, cluster-label auto-fill) — its own
    // dependencies travel with it, same reasoning as every script above.
    "remote-paseo.mjs",
    "model-routing.mjs",
    "reliability.mjs",
    // team-communication.mjs joined it when the Lead -> Supervisor consult
    // (PR-H) started resolving policy-core to find the Supervisor seat. Same
    // lazy shape as remote-paseo.mjs `run`: only that one command touches the
    // core, and only at runtime.
    "team-communication.mjs",
  ]) {
    cpSync(join(source, file), join(scriptsDir, file));
  }
  for (const role of ["supervisor", "lead", "peer"]) {
    cpSync(join(root, "prompts", `${role}.md`), join(extDir, "prompts", `${role}.md`));
  }
  const hookPath = join(scriptsDir, "claude-hook.mjs");
  const hookEnv = {
    ...process.env,
    PASEO_PI_ROLE: "peer",
    PASEO_TEAM_HOME: join(unrelatedCwd, "claude-state"),
  };
  // No brief anywhere → read-only, so a write tool must be denied. This proves
  // the hook found the policy core through the installed layout: a resolution
  // failure would surface as the fail-closed "hook failed" reason instead.
  const denied = execFileSync(process.execPath, [hookPath, "pre-tool-use"], {
    cwd: unrelatedCwd,
    env: hookEnv,
    encoding: "utf8",
    input: JSON.stringify({
      session_id: "installer-contract",
      tool_name: "Write",
      tool_input: { file_path: "x.txt" },
    }),
  });
  const decision = JSON.parse(denied).hookSpecificOutput;
  assert.equal(decision.permissionDecision, "deny");
  assert.match(decision.permissionDecisionReason, /read-only/);
  assert.doesNotMatch(decision.permissionDecisionReason, /hook failed/);

  // The role prompt must resolve from the installed extensions dir too.
  const injected = execFileSync(process.execPath, [hookPath, "session-start"], {
    cwd: unrelatedCwd,
    env: hookEnv,
    encoding: "utf8",
    input: JSON.stringify({ session_id: "installer-contract" }),
  });
  assert.match(JSON.parse(injected).hookSpecificOutput.additionalContext, /Paseo Team Role/);

  // And the MCP server answers a handshake from the installed location.
  const handshake = execFileSync(
    process.execPath,
    [join(scriptsDir, "claude-team-mcp.mjs")],
    {
      cwd: unrelatedCwd,
      env: hookEnv,
      encoding: "utf8",
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
    },
  );
  const tools = JSON.parse(handshake).result.tools.map((tool) => tool.name);
  assert.deepEqual(tools.sort(), [
    "lead_ask_supervisor",
    "peer_ask_lead",
    "team_fork",
    "team_lease",
    "team_watchdog",
  ]);

  // Each core-dependent script must at least LOAD from the installed layout.
  // Running with no arguments is enough: the usage error proves the module
  // graph resolved, and an unresolved import cannot produce it.
  for (const script of ["team-lease.mjs", "team-fork.mjs"]) {
    let stdout = "";
    try {
      stdout = execFileSync(process.execPath, [join(scriptsDir, script)], {
        cwd: unrelatedCwd,
        env: hookEnv,
        encoding: "utf8",
      });
    } catch (error) {
      // These scripts report their usage error on stderr and exit non-zero.
      stdout = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    assert.match(stdout, /"code":"USAGE"/, `${script} must load from the installed layout`);
    assert.doesNotMatch(stdout, /ERR_MODULE_NOT_FOUND/, `${script} could not resolve the policy core`);
  }

  // remote-paseo.mjs's `run` command lazily resolves policy-core (for the
  // cluster-label auto-fill) ONLY at runtime, ONLY for `run` — the exact shape
  // of bug PR-C shipped once already: an import path that is right in a
  // checkout and wrong in an installed tree fails at IMPORT time, and the
  // caller sees it as something unrelated (there, an unreadable lease ledger;
  // here it would be every remote `run` refusing with a bare team.cluster
  // message even though the Lead's own cluster resolves fine). `--help` alone
  // would not exercise this path at all — it returns before `run` is even
  // parsed — so this drives `run` specifically, in the REAL installed layout
  // (paseo-team-scripts/ + paseo-team-core/ siblings), unlike the flat-copy
  // `--help` check earlier in this file, which ships remote-paseo.mjs with NO
  // policy core alongside it at all and must keep working for exactly that
  // reason.
  {
    let runOutput = "";
    try {
      runOutput = execFileSync(process.execPath, [join(scriptsDir, "remote-paseo.mjs"), "run"], {
        cwd: unrelatedCwd,
        env: hookEnv,
        encoding: "utf8",
      });
    } catch (error) {
      // remote-paseo.mjs exits non-zero on every error path; its JSON envelope
      // is still on stdout.
      runOutput = error.stdout ?? "";
    }
    runOutput = runOutput.trim();
    const parsed = JSON.parse(runOutput);
    assert.equal(parsed.ok, false, "run with no other args cannot succeed");
    assert.ok(
      typeof parsed.code === "string" && parsed.code.length > 0,
      "a clean structured error, not a crash",
    );
    assert.doesNotMatch(
      runOutput,
      /ERR_MODULE_NOT_FOUND/,
      "remote-paseo.mjs could not resolve the policy core for the cluster-label auto-fill",
    );
  }

  // team-communication.mjs resolves policy-core the same lazy way, and only on
  // the `ask-supervisor` path — the Peer's `ask-lead` must not pay for, or fail
  // on, a module it never touches. That split is precisely the PR-C shape
  // again: if the lazy path cannot resolve the core from an installed tree, a
  // Lead's consult dies at IMPORT time and the Lead reads it as "there is no
  // Supervisor" — then asks the Human, which is the behaviour the channel
  // exists to remove. So this drives `ask-supervisor` specifically, with no
  // PASEO_AGENT_ID: the run must get far enough to fail on the MISSING AGENT
  // ID rather than on a missing module.
  {
    let consultOutput = "";
    try {
      consultOutput = execFileSync(
        process.execPath,
        [join(scriptsDir, "team-communication.mjs"), "ask-supervisor", JSON.stringify({
          kind: "decision",
          question: "q",
          options: "a or b",
          evidence: "e",
          scope: "src/x.ts",
          reversibility: "reversible",
        })],
        { cwd: unrelatedCwd, env: { ...hookEnv, PASEO_AGENT_ID: "" }, encoding: "utf8" },
      );
    } catch (error) {
      consultOutput = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    assert.doesNotMatch(
      consultOutput,
      /ERR_MODULE_NOT_FOUND/,
      "team-communication.mjs could not resolve the policy core for the consult path",
    );
    assert.match(
      consultOutput,
      /"code":"AGENT_ID_MISSING"/,
      "the consult path must reach its own validation, proving the core loaded",
    );
  }
}

console.log("installer contract tests passed");
