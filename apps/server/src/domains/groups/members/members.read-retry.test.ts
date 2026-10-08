import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Повтор чтения участника: на Windows файл, который в эту секунду пишет
 * другой процесс, отвечает EBUSY, и без повтора скилл пропадал из пути группы.
 * Подменён только сбой первого чтения — файл, каталог и хэш настоящие.
 */

const failures = { left: 0 };

vi.mock('../../../lib/safe-io/safe-io.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/safe-io/safe-io.ts')>();
  return {
    ...real,
    readTextFile: (file: string) => {
      if (failures.left > 0) {
        failures.left -= 1;
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return real.readTextFile(file);
    },
  };
});

const { memberContent } = await import('./members.ts');
const { originChangedOf } = await import('../views.ts');

describe('чтение участника группы', () => {
  let root: string;
  const deps = () => ({ paths: { skills: join(root, 'skills') } as never, store: {} as never });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-member-read-'));
    mkdirSync(join(root, 'skills', 'ladder'), { recursive: true });
    writeFileSync(join(root, 'skills', 'ladder', 'SKILL.md'), '## 1. Read\n\n## 2. Ship\n', 'utf8');
  });

  afterEach(() => {
    failures.left = 0;
    rmSync(root, { recursive: true, force: true });
  });

  it('разовый сбой чтения повторяется — скилл читается, onError не зовётся', () => {
    failures.left = 1;
    const onError = vi.fn();
    const content = memberContent(
      deps(),
      { kind: 'global' },
      { kind: 'skill', id: 'ladder' },
      onError,
    );
    expect(content?.text).toContain('## 2. Ship');
    expect(onError).not.toHaveBeenCalled();
  });

  it('сбой и со второго раза — undefined и onError с причиной', () => {
    failures.left = 2;
    const onError = vi.fn();
    const content = memberContent(
      deps(),
      { kind: 'global' },
      { kind: 'skill', id: 'ladder' },
      onError,
    );
    expect(content).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]![0])).toContain('EBUSY');
  });
});

// Ревью 28.09 (F-251): повтор шёл сразу — блокировка редактора, державшаяся
// миллисекунды, на повторе была ещё на месте. (F-250): дважды не прочёлся —
// «неизвестно», а не «удалён в проекте» на карточке копии.
describe('повтор с паузой и неизвестное состояние', () => {
  let root: string;
  const deps = () =>
    ({
      paths: { skills: join(root, 'skills'), appData: root } as never,
      store: {} as never,
    }) as never;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-member-pause-'));
    mkdirSync(join(root, 'skills', 'ladder'), { recursive: true });
    writeFileSync(join(root, 'skills', 'ladder', 'SKILL.md'), 'x\n', 'utf8');
  });

  afterEach(() => {
    failures.left = 0;
    rmSync(root, { recursive: true, force: true });
  });

  it('перед повтором есть пауза', () => {
    failures.left = 1;
    const started = performance.now();
    memberContent(deps(), { kind: 'global' }, { kind: 'skill', id: 'ladder' });
    expect(performance.now() - started).toBeGreaterThanOrEqual(40);
  });

  it('заблокированный участник оригинала не числится изменённым', () => {
    const hash = memberContent(deps(), { kind: 'global' }, { kind: 'skill', id: 'ladder' })!.hash;
    const copy = {
      id: 'copy',
      members: [{ kind: 'skill', id: 'ladder' }],
      origin: {
        scope: { kind: 'global' },
        groupId: 'gone',
        hash: 'h',
        copiedAt: '2026-09-28T00:00:00.000Z',
        memberHashes: { 'skill:ladder': hash },
      },
    };
    failures.left = 2;
    expect(originChangedOf(deps(), [], copy as never)).toEqual([]);
  });
});
