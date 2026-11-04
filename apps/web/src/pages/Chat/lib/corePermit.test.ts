import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandDraft } from '@entities/CoreTask';

const sent: CommandDraft[] = [];
let reject: Partial<Record<string, string>> = {};

// Отправка ядру — граница сети: команда записана, исход по виду команды.
vi.mock('@entities/CoreTask', async (importOriginal) => {
  const real = await importOriginal<typeof import('@entities/CoreTask')>();
  return {
    ...real,
    sendCoreCommand: async (draft: CommandDraft) => {
      sent.push(draft);
      const code = reject[draft.kind];
      return code
        ? { cmdId: 'c', status: 'rejected', code, reason: `no ${draft.kind}` }
        : { cmdId: 'c', status: 'applied', seq: sent.length };
    },
  };
});

const toastError = vi.fn();
vi.mock('@shared/lib/toast', () => ({ toast: { error: (m: string) => toastError(m) } }));

const { autoGrantDraft, corePermitDrafts, decideCorePermit, sendInOrder } =
  await import('./corePermit');

const CARD = {
  taskId: 't-1',
  askId: 'a-1',
  point: 5,
  options: ['grant', 'refuse'],
  project: 'repo-abc',
  globs: ['guarded/a1.txt'],
};

beforeEach(() => {
  sent.length = 0;
  reject = {};
  toastError.mockReset();
});

describe('вопрос права ядра → команды окна (этап 10, F2b)', () => {
  it('«Разрешить» на пункте 5: грант на путь отказа, затем ответ grant', () => {
    expect(corePermitDrafts(CARD, 'allow')).toEqual([
      {
        kind: 'grant',
        taskId: 't-1',
        fields: { project: 'repo-abc', globs: ['guarded/a1.txt'], ops: ['edit'] },
      },
      { kind: 'answer', taskId: 't-1', fields: { askId: 'a-1', answer: 'grant' } },
    ]);
  });

  it('«Запретить»: ответ refuse, без гранта', () => {
    expect(corePermitDrafts(CARD, 'deny')).toEqual([
      { kind: 'answer', taskId: 't-1', fields: { askId: 'a-1', answer: 'refuse' } },
    ]);
  });

  it('вопрос без варианта grant (пункт 3): ответ первым вариантом ядра', () => {
    expect(corePermitDrafts({ ...CARD, point: 3, options: ['allow', 'refuse'] }, 'allow')).toEqual([
      { kind: 'answer', taskId: 't-1', fields: { askId: 'a-1', answer: 'allow' } },
    ]);
  });

  it('ядро не назвало репозиторий или путь: гранта собрать не из чего — null', () => {
    expect(corePermitDrafts({ ...CARD, project: null }, 'allow')).toBeNull();
    expect(corePermitDrafts({ ...CARD, globs: [] }, 'allow')).toBeNull();
  });

  it('автоподтверждение: грант правки всему репозиторию', () => {
    expect(autoGrantDraft('t-1', 'repo-abc')).toEqual({
      kind: 'grant',
      taskId: 't-1',
      fields: { project: 'repo-abc', globs: ['**'], ops: ['edit'] },
    });
  });

  it('отказ ядра на гранте: ответ уже не уходит, причина словами ядра', async () => {
    reject = { grant: 'signature-required' };
    const refused = await sendInOrder(corePermitDrafts(CARD, 'allow')!);
    expect(refused).not.toBeNull();
    expect(sent.map((d) => d.kind)).toEqual(['grant']);
  });

  it('клик: команды по порядку; отказ — тост, карточка остаётся (true только при приёме)', async () => {
    await expect(decideCorePermit(CARD, 'allow')).resolves.toBe(true);
    expect(sent.map((d) => d.kind)).toEqual(['grant', 'answer']);
    expect(toastError).not.toHaveBeenCalled();
    sent.length = 0;
    reject = { answer: 'signature-required' };
    await expect(decideCorePermit(CARD, 'deny')).resolves.toBe(false);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('клик без гранта: тост «не из чего», ядру ничего не уходит', async () => {
    await expect(decideCorePermit({ ...CARD, globs: [] }, 'allow')).resolves.toBe(false);
    expect(sent).toEqual([]);
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
