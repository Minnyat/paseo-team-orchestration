#!/usr/bin/env node
/**
 * mutate.mjs — break the code on purpose, and see whether the suite notices.
 *
 * `npm test` answers "do the tests pass?". It cannot answer "would these tests
 * have caught the bug?", and on this repo the two came apart badly: a review of
 * one branch found nine real defects while all 139 tests were green. This is
 * the tool that turned that from an impression into a measurement.
 *
 *   node test/tools/mutate.mjs <mutations.json>
 *
 * Each entry is `{ id, file, from, to }`. The anchor must appear EXACTLY once —
 * an ambiguous or missing anchor is reported rather than applied, because a
 * mutation that silently did nothing looks exactly like a mutation the tests
 * killed, and that is the one failure mode a tool like this must not have.
 *
 * A SURVIVED verdict means the suite passed with the code deliberately broken.
 * Every survivor is either a real coverage gap or an equivalent mutation, and
 * you have to look to tell which: `installed: x || y` mutated to
 * `installed: x && true || y` survives because it is the same expression, not
 * because anything is missing.
 *
 * What this measured here, and what it is worth re-running after: mutations to
 * the pure modules were killed almost without exception, while mutations to the
 * top-level composition layers — the file that decides which checks run and at
 * what severity, and the one that decides what an uninstall deletes — survived
 * every time, because nothing executed those files at all. Coverage of a
 * module's functions says nothing about coverage of the file that calls them.
 *
 * Use `node --test --experimental-test-coverage` to SCREEN for that (it is what
 * pointed at the Pi adapter), but verify with this tool, not with the
 * percentage. The percentage lies in at least one place here: policy.test.mts
 * loads the Pi adapter through `import("../extensions/paseo-team-policy.ts?tag")`
 * to get a fresh module per scenario, and the coverage reporter does not
 * attribute a query-string specifier back to the base file — so lines that
 * demonstrably execute (break one and a test fails) are still listed as
 * uncovered. A coverage FLOOR on that file would be a number nobody can move.
 *
 * The file is restored in a `finally`, and a .ts mutation rebuilds before and
 * after, so an interrupted run leaves the tree buildable.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/home/user/paseo-team-orchestration";
const MUTATIONS = JSON.parse(readFileSync(process.argv[2], "utf8"));

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], timeout: 600000 });
    return true;
  } catch { return false; }
}

const results = [];
for (const m of MUTATIONS) {
  const path = join(ROOT, m.file);
  const original = readFileSync(path, "utf8");
  if (!original.includes(m.from)) { results.push({ ...m, verdict: "ANCHOR-MISSING" }); continue; }
  const occurrences = original.split(m.from).length - 1;
  if (occurrences !== 1) { results.push({ ...m, verdict: `ANCHOR-AMBIGUOUS(${occurrences})` }); continue; }
  writeFileSync(path, original.replace(m.from, m.to));
  try {
    if (m.file.endsWith(".ts")) run("npx", ["tsc", "-p", "tsconfig.build.json"]);
    const passed = run("node", ["--test", "test/*.test.mjs", "test/*.test.mts"]);
    results.push({ ...m, verdict: passed ? "SURVIVED" : "killed" });
  } finally {
    writeFileSync(path, original);
    if (m.file.endsWith(".ts")) run("npx", ["tsc", "-p", "tsconfig.build.json"]);
  }
  const last = results[results.length - 1];
  process.stderr.write(`${last.verdict === "SURVIVED" ? "!! SURVIVED" : "   killed  "}  ${m.id}\n`);
}
console.log(JSON.stringify(results.map(({ from, to, ...r }) => r), null, 1));
