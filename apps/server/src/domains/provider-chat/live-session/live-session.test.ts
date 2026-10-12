import { describe, it, expect } from 'vitest';
import type { ProviderChatMessage } from '@agentdeck/contracts';
import {
  digestMessages,
  digestPreamble,
  planLiveSession,
  type ProviderChatLiveSession,
} from './live-session.ts';

/**
 * @covers live-session.ts
 * @scenario отметка продолжается, только пока совпадает всё, что видела сессия:
 *   реплики (id, роль, текст, провал), модель, каталог; иначе — «удалить».
 */

const at = '2026-01-01T00:00:00.000Z';
const MESSAGES: ProviderChatMessage[] = [
  { id: 'm1', role: 'user', content: 'Вопрос', at },
  { id: 'm2', role: 'assistant', content: 'Ответ', at },
  { id: 'm3', role: 'user', content: 'Ещё', at },
];
const MARK: ProviderChatLiveSession = {
  kind: 'codex-app-server',
  id: 'thr-1',
  covered: 2,
  digest: digestMessages(MESSAGES.slice(0, 2)),
  preamble: 'P',
  model: 'gpt-x',
  workdir: '/w',
};
const NOW = { messages: MESSAGES, model: 'gpt-x', workdir: '/w' };
const DROP = { kind: 'codex-app-server', id: 'thr-1' };

describe('planLiveSession', () => {
  it('отметки нет — первая сессия', () => {
    expect(planLiveSession(undefined, NOW)).toBeUndefined();
  });

  it('всё совпадает — продолжить с числом увиденных реплик', () => {
    expect(planLiveSession(MARK, NOW)).toEqual({ ...DROP, covered: 2, preamble: 'P' });
  });

  it.each([
    ['непригодная', { ...MARK, stale: true as const }, NOW],
    ['без отпечатка', { ...MARK, digest: undefined }, NOW],
    ['другая модель', MARK, { ...NOW, model: 'gpt-y' }],
    ['другой каталог', MARK, { ...NOW, workdir: '/other' }],
    ['переписка короче увиденного', MARK, { ...NOW, messages: MESSAGES.slice(0, 1) }],
    ['ноль увиденных', { ...MARK, covered: 0, digest: digestMessages([]) }, NOW],
    [
      'правка увиденной реплики',
      MARK,
      { ...NOW, messages: [{ ...MESSAGES[0]!, content: 'Вопрос (правка)' }, ...MESSAGES.slice(1)] },
    ],
  ])('%s — только удалить', (_name, mark, now) => {
    expect(planLiveSession(mark, now)).toEqual(DROP);
  });

  it('модель и каталог «по умолчанию» сравниваются как пустая строка', () => {
    const bare = { ...MARK, model: undefined, workdir: undefined };
    expect(planLiveSession(bare, { ...NOW, model: '', workdir: '' })).toMatchObject({ covered: 2 });
  });
});

describe('отпечатки', () => {
  it('пометка провала меняет отпечаток реплик', () => {
    const failed = [{ ...MESSAGES[0]!, failed: true }];
    expect(digestMessages(failed)).not.toBe(digestMessages(MESSAGES.slice(0, 1)));
  });

  it('id реплики входит в отпечаток', () => {
    const renamed = [{ ...MESSAGES[0]!, id: 'other' }];
    expect(digestMessages(renamed)).not.toBe(digestMessages(MESSAGES.slice(0, 1)));
  });

  it('границы блоков постоянной части различимы', () => {
    expect(digestPreamble(['ab', 'c'])).not.toBe(digestPreamble(['a', 'bc']));
  });
});
