// Runs the four stub-DB verification harnesses against the compiled output in
// dist/. Each drives the real application with only the pg pool replaced, and
// exits non-zero on any failed check. `npm test` builds before this runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Tests run from the repository root through npm, so cwd is the root.
const ROOT = process.cwd();
const HARNESSES = ['t7-harness', 't7-boot', 't8-kdf', 't8-boot'];

for (const name of HARNESSES) {
  test(`harness ${name} passes against dist/`, () => {
    const run = spawnSync(process.execPath, [path.join(ROOT, '.agents/wiki/context', `${name}.js`)], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const output = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 0, output);
    assert.match(output, /\d+ passed, 0 failed/);
  });
}
