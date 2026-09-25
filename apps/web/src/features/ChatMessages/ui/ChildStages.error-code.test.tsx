import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { i18n } from '@shared/config/i18n';
import { mergeSplitGroups, splitGroupKey } from '../lib/mergeSplitGroups';
import type { ChildStageGroup } from './ChildStages.types';
import { ChildStages } from './ChildStages';

type Group = SplitPlanView['groups'][number];

/**
 * Причина сбоя группы и «чего не хватило до доставки» в хабе — на языке
 * интерфейса (живой стенд 25.09.2026: в английском хабе они шли русской
 * строкой сервера). Склейка конвейера рисуется настоящей карточкой хаба.
 */

const group = (index: number, extra: Partial<Group> = {}): Group => ({
  index,
  title: `Группа ${index}`,
  branch: `agent/g${index}`,
  after: [],
  status: 'pending',
  ...extra,
});

function render(rows: Map<string, ChildStageGroup>, groups: Group[]): string {
  const merged = mergeSplitGroups(rows, {
    parentChatId: 'parent',
    triage: { at: '2026-09-25T10:00:00.000Z', received: true, repairs: [], conflicts: [] },
    order: groups.map((item) => item.index),
    groups,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildStages groups={merged} onOpen={() => {}} />
    </QueryClientProvider>,
  );
}

const textOf = (html: string): string => html.replace(/<[^>]+>/g, '|');
const CYRILLIC = /[А-Яа-яЁё]/;

const DIRTY = 'незакоммиченные правки: a.ts';
const NOT_PUSHED = 'ветка agent/g1 не отправлена на удалённый (или отстаёт от HEAD копии)';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('хаб разделения — причина сбоя группы на языке интерфейса', () => {
  it('копия не завелась: причина по коду, а не русской строкой', () => {
    const html = render(new Map(), [
      group(0, {
        status: 'failed',
        error: 'прогон не запустился',
        errorCode: 'split-group-run-not-started',
      }),
    ]);

    expect(textOf(html)).toContain('the run did not start');
    expect(html).not.toContain('прогон не запустился');
  });

  it('группа с чатом сдалась на доставке: причина и список пробелов — по вложенным кодам', () => {
    const key = splitGroupKey({ groupIndex: 1, id: '' });
    const html = render(
      new Map<string, ChildStageGroup>([
        [key, { chatId: 'c1', title: 'Группа 1', stages: ['work'], isRunning: false }],
      ]),
      [
        group(1, {
          status: 'failed',
          chatId: 'c1',
          error: `доставка не доведена: ${DIRTY}; ${NOT_PUSHED}`,
          errorCode: 'split-delivery-incomplete-2',
          errorParams: {
            first: { messageCode: 'delivery-gap-dirty', params: { files: 'a.ts' } },
            second: { messageCode: 'delivery-gap-not-pushed', params: { branch: 'agent/g1' } },
          },
          deliveryMissing: [DIRTY, NOT_PUSHED],
          deliveryMissingCodes: [
            { messageCode: 'delivery-gap-dirty', params: { files: 'a.ts' } },
            { messageCode: 'delivery-gap-not-pushed', params: { branch: 'agent/g1' } },
          ],
        }),
      ],
    );
    const text = textOf(html);

    expect(text).toContain(
      'stopped: delivery not completed: uncommitted changes: a.ts; branch agent/g1',
    );
    // Группа работала — «не завелась» ей не пишется (живой прогон 25.09, D5).
    expect(text).not.toContain('did not start');
    expect(text).toContain('missing for the MR: uncommitted changes: a.ts; branch agent/g1');
    // Подсказка по наведению — тот же список, тоже на языке интерфейса.
    expect(html).toContain('title="uncommitted changes: a.ts\nbranch agent/g1');
    expect(CYRILLIC.test(text.replace(/Группа \d/g, ''))).toBe(false);
  });

  it('причина без кода (чужая или от сервера постарше) — как есть', () => {
    const html = render(new Map(), [group(2, { status: 'failed', error: 'spawn claude ENOENT' })]);

    expect(textOf(html)).toContain('spawn claude ENOENT');
  });
});
