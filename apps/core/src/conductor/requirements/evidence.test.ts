import type { CheckClass, RecordOrigin } from '@agentdeck/contracts/core/records';
import { describe, expect, it } from 'vitest';
import { evidenceProblem } from './evidence.ts';
import type { EvidenceFacts, EvidenceRecord } from './requirements.types.ts';

/**
 * P92 таблицей: класс проверки × замыкание единицы против изменённых файлов × кто исполнил.
 * Покрывает требование только прогон ядра этой задачи, не статический, со свежим ключом и
 * замыканием, задевающим хотя бы один изменённый файл.
 */

const TASK = '01920000-0000-7000-8000-0000000000a1';
const KEY = 'a'.repeat(64);

function facts(
  over: {
    record?: Partial<EvidenceRecord>;
    cls?: CheckClass;
    closure?: string[];
    changed?: string[];
    key?: string;
  } = {},
): EvidenceFacts {
  return {
    record: {
      value: {
        verdict: 'pass',
        checkId: 'tests',
        taskId: TASK,
        origin: 'core',
        key: KEY,
        unit: 'web',
        selection: [],
        ...over.record,
      },
    },
    now: {
      value: {
        key: over.key ?? KEY,
        class: over.cls ?? 'test-runner',
        closure: over.closure ?? ['apps/web/'],
      },
    },
    changed: { value: over.changed ?? ['apps/web/src/a.ts'] },
  };
}

const code = (f: EvidenceFacts) => evidenceProblem(f, TASK)?.code ?? 'covers';

describe('evidenceProblem — P92 relevance', () => {
  it('class × closure × origin', () => {
    const classes: CheckClass[] = ['static', 'test-runner', 'build', 'live', 'contract'];
    const closures: [string, string[], boolean][] = [
      ['closure holds the file', ['apps/web/'], true],
      ['whole repo', [''], true],
      ['closure misses', ['packages/ui/'], false],
    ];
    const origins: RecordOrigin[] = ['core', 'session', 'unattended', 'pseudo'];
    for (const cls of classes)
      for (const [label, closure, hits] of closures)
        for (const origin of origins) {
          const expected =
            origin !== 'core'
              ? 'captured-evidence'
              : cls === 'static'
                ? 'irrelevant-evidence'
                : hits
                  ? 'covers'
                  : 'irrelevant-evidence';
          expect(
            code(facts({ cls, closure, record: { origin } })),
            `${cls} / ${label} / ${origin}`,
          ).toBe(expected);
        }
  });

  it('order and doubt: red, no-verdict, foreign, derived id, stale key, unreadable reads all refuse', () => {
    const rows: [string, EvidenceFacts, string][] = [
      ['absent', { ...facts(), record: { absent: true } }, 'missing'],
      ['unreadable record', { ...facts(), record: { unknown: 'locked' } }, 'missing'],
      ['red', facts({ record: { verdict: 'fail' } }), 'red'],
      ['no verdict', facts({ record: { verdict: 'no-verdict' } }), 'no-verdict'],
      ['flaky green covers', facts({ record: { verdict: 'pass-flaky' } }), 'covers'],
      ['foreign task', facts({ record: { taskId: 'x' } }), 'foreign-task'],
      ['derived argv', facts({ record: { checkId: 'captured:1a2b3c4d' } }), 'captured-evidence'],
      ['moved tree', facts({ key: 'b'.repeat(64) }), 'stale-evidence'],
      ['key unreadable', { ...facts(), now: { unknown: 'index locked' } }, 'stale-evidence'],
      ['diff unreadable', { ...facts(), changed: { unknown: 'timeout' } }, 'irrelevant-evidence'],
      ['nothing changed', facts({ changed: [] }), 'irrelevant-evidence'],
    ];
    for (const [name, f, expected] of rows) expect(code(f), name).toBe(expected);
  });
});
