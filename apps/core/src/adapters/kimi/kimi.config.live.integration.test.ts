import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kimiRunFacts } from '@agentdeck/providers/kimi';
import { afterAll, describe, expect, it } from 'vitest';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import { liveRoot } from '../conformance/__fixtures__/live.ts';
import { kimiConfigFile } from './kimi.ts';

/**
 * config.toml сеанса Kimi на настоящем валидаторе CLI (образ `--clis` у `tools/core-linux.mjs`;
 * без kimi — пропуск). `kimi doctor config` — та же схема, что грузит запуск: на недопустимом
 * ключе запуск его молча выбрасывает («Ignored invalid config»), поэтому зелёный старт сеанса
 * ничего не доказывает, а доктор говорит прямо. Проба 2.4.1: `default_permission_mode = "default"`
 * → «Invalid input», выход 1.
 */

const present = hasCli(kimiRunFacts.binary.command);
const live = liveRoot('kimi-config-');

afterAll(() => {
  rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
});

describe.skipIf(!present)('kimi session config.toml against kimi doctor (live)', () => {
  it('kimiConfigFile passes kimi doctor config: permission mode valid, hook table kept', () => {
    mkdirSync(live.root, { recursive: true });
    const file = join(live.root, 'config.toml');
    writeFileSync(file, kimiConfigFile('node "/s/run.ts" hook'));
    const run = spawnSync(kimiRunFacts.binary.command, ['doctor', 'config', file], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      windowsHide: true,
      timeout: 60_000,
    });
    const out = `${run.stdout}\n${run.stderr}`;
    expect(out).not.toMatch(/Invalid|ERROR/);
    expect(out).toContain('OK config.toml');
    expect(run.status).toBe(0);
  }, 90_000);
});
