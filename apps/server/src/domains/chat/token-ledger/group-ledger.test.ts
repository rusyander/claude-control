import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../../lib/app-store/app-store.types.ts';
import { groupTokenLedger } from './group-ledger.ts';

/**
 * @covers apps/server/src/domains/chat/token-ledger/group-ledger.ts
 * @scenario Группа на чужом CLI (E4): расхода он не пишет, на карточке — только
 * одинаковые файлы инструкций, которые он прочтёт. Пути — из настоящих
 * разделов провайдера, дом CLI уведён во временный каталог.
 */

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const RULES = 'Follow the project rules before editing. '.repeat(12);

function setup(home: string, project: string) {
  const root = mkdtempSync(join(tmpdir(), 'foreign-ledger-'));
  dirs.push(root);
  const codexHome = join(root, 'codex-home');
  const copy = join(root, 'copy');
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(codexHome, 'AGENTS.md'), home);
  writeFileSync(join(copy, 'AGENTS.md'), project);
  vi.stubEnv('CODEX_HOME', codexHome);
  return { root, codexHome, copy };
}

const record = { parentChatId: 'p' } as SplitPlanRecord;
const measure = groupTokenLedger({
  links: () => ({}),
  projectsDir: () => join(tmpdir(), 'no-transcripts-here'),
  now: () => new Date('2026-10-12T10:00:00.000Z'),
});

describe('groupTokenLedger: чужой CLI', () => {
  it('домашний и проектный AGENTS.md с одним текстом — дубль на карточке', async () => {
    const { codexHome, copy } = setup(RULES, RULES.replaceAll(' ', '  '));
    const group = { index: 0, path: copy } as SplitPlanGroupRecord;

    const ledger = await measure(record, group, 'codex');

    expect(ledger?.usage).toBeUndefined();
    expect(ledger?.duplicates?.map((path) => path.replaceAll('\\', '/')).sort()).toEqual(
      [join(codexHome, 'AGENTS.md'), join(copy, 'AGENTS.md')]
        .map((path) => path.replaceAll('\\', '/'))
        .sort(),
    );
  });

  it('тексты разные — счёта нет', async () => {
    const { copy } = setup(RULES, `${RULES} And one project-only rule.`);
    const group = { index: 0, path: copy } as SplitPlanGroupRecord;
    await expect(measure(record, group, 'codex')).resolves.toBeUndefined();
  });
});
