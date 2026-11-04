import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Проверка строк переноса (спека 10:18, этап 10) через её настоящий вход — CLI
 * `tools/check-core/migration-rows.mjs` на временном дереве и временной спеке. Красное — модуль
 * без строки и живой путь строки, помеченной `switched`; зелёное — всё покрыто и переключённого
 * пути нет. Скрипт без зависимостей, поэтому его проверяет тест сервера, чьи модули он сторожит.
 */

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../tools/check-core/migration-rows.mjs',
);
const SERVER = 'apps/server/src';

const ROWS = [
  '| `chat/alpha.ts`, `beta` | journal | 2 |',
  '| `provider-foo` | adapters | 10 |',
  '| `bootstrap/x-wiring` | wiring | 5 |',
  '| `providers/reg.ts` | registry | 2 |',
  '| `tools/qa/stub-a.mjs` | stub-model scenario | 2 |',
  '| kit `gate.mjs` | verifier | 3 |',
];

function spec(rows: readonly string[], stays = 'Kit hooks without a core class stay.'): string {
  return [
    '# 10',
    '',
    '## Rows',
    '| module | class / core part | ph |',
    '|---|---|---|',
    ...rows,
    '',
    '## Stays',
    stays,
    '',
  ].join('\n');
}

let root: string;

function file(rel: string, text = 'export {};\n'): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function run(specText: string | null): { code: number | null; out: string } {
  const specPath = join(root, 'spec.md');
  if (specText !== null) writeFileSync(specPath, specText);
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--spec', specPath], {
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-migration-rows-'));
  file(`${SERVER}/domains/chat/alpha.ts`);
  file(`${SERVER}/domains/chat/alpha.types.ts`);
  file(`${SERVER}/domains/chat/beta/index.ts`);
  file(`${SERVER}/domains/chat/beta.test.ts`);
  file(`${SERVER}/domains/provider-foo/index.ts`);
  file(`${SERVER}/bootstrap/x-wiring/index.ts`);
  file(`${SERVER}/providers/reg.ts`);
  file('tools/qa/stub-a.mjs');
  file('apps/server/assets/kit/agentdeck-kit/hooks/gate.mjs');
  file('apps/server/assets/kit/agentdeck-kit/hooks/other.mjs');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('migration-rows (10:18): every module has a row, a switched row has no path left', () => {
  it('green when every module is a row or a stays entry; a test file and a .types sibling are not modules', () => {
    const r = run(spec(ROWS));
    expect(r.out).toContain('modules 8');
    expect(r.out).toContain('[migration-rows] green');
    expect(r.code).toBe(0);
  });

  it('a dropped row turns its modules red and names each one', () => {
    const r = run(spec(ROWS.slice(1)));
    expect(r.code).toBe(1);
    expect(r.out).toContain(`UNCOVERED ${SERVER}/domains/chat/alpha`);
    expect(r.out).toContain(`UNCOVERED ${SERVER}/domains/chat/beta`);
    expect(r.out).toContain('red: 2 uncovered, 0 alive');
  });

  it('a row marked switched is red while its path exists and green once the path is gone', () => {
    const switched = ROWS.map((row) =>
      row.includes('provider-foo') ? row.replace('| 10 |', '| 10 switched |') : row,
    );
    const alive = run(spec(switched));
    expect(alive.code).toBe(1);
    expect(alive.out).toMatch(
      /ALIVE 10:\d+ apps\/server\/src\/domains\/provider-foo — row is switched/,
    );
    rmSync(join(root, SERVER, 'domains/provider-foo'), { recursive: true });
    const gone = run(spec(switched));
    expect(gone.out).toContain('[migration-rows] green');
    expect(gone.code).toBe(0);
  });

  it('a name inside parentheses is a note, not a row: it covers nothing', () => {
    const rows = ROWS.filter((row) => !row.includes('x-wiring')).map((row) =>
      row.includes('chat/alpha')
        ? row.replace('`beta`', '`beta` (not server `bootstrap/x-wiring`)')
        : row,
    );
    const r = run(spec(rows));
    expect(r.code).toBe(1);
    expect(r.out).toContain(`UNCOVERED ${SERVER}/bootstrap/x-wiring`);
  });

  it('kit hooks without a row stay only while the Stays section says so', () => {
    const r = run(spec(ROWS, 'Panel UI stays.'));
    expect(r.code).toBe(1);
    expect(r.out).toContain('UNCOVERED apps/server/assets/kit/agentdeck-kit/hooks/other');
    expect(r.out).not.toContain('hooks/gate —');
  });

  it('a missing spec is a usage error (exit 2), never green', () => {
    const r = run(null);
    expect(r.code).toBe(2);
    expect(r.out).toContain('spec not found');
  });
});
