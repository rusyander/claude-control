import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { KEEPER_MAIN } from './kept-launch.ts';

const dir = mkdtempSync(join(tmpdir(), 'keeper-main-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('F-112 keeper main — the spec file (it carries env) never outlives the keeper', () => {
  it('F-112 a spec that is not JSON → exit 125 and the spec file is gone', () => {
    const spec = join(dir, 'keeper-spec.json');
    writeFileSync(spec, '{"env":{"TOKEN":"FAKE-VENDOR-secret"}, broken');
    const run = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', KEEPER_MAIN, spec],
      { encoding: 'utf8', timeout: 20_000 },
    );
    expect(run.status).toBe(125);
    expect(existsSync(spec)).toBe(false);
  });

  it('F-112 JSON of the wrong shape (no command) → exit 125, spec removed', () => {
    const spec = join(dir, 'keeper-spec-2.json');
    writeFileSync(spec, JSON.stringify({ env: { A: '1' } }));
    const run = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', KEEPER_MAIN, spec],
      { encoding: 'utf8', timeout: 20_000 },
    );
    expect(run.status).toBe(125);
    expect(existsSync(spec)).toBe(false);
  });
});
