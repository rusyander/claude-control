import { afterAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { i18n } from '@shared/config/i18n';
import { mergeSplitGroups } from '../../lib/mergeSplitGroups';
import type { ChildStageGroup } from '../ChildStages.types';
import { ChildStages } from '../ChildStages/ChildStages';
import { splitGroupKey } from '../../lib/splitGroupKey';

/**
 * @covers apps/web/src/features/ChatMessages/ui/GroupText/GroupText.tsx
 * @covers apps/web/src/features/ChatMessages/lib/reviewCloseText.ts
 * @covers apps/web/src/features/ChatMessages/lib/mergeSplitGroups.ts
 * @scenario Группа ревью закрылась: карточка показывает факты по копии — правки
 * в дереве, которое ревью не должно трогать (T13), временные копии (T6/T11) и
 * снятую базу (T7), — по-русски и по-английски.
 */

type ViewGroup = SplitPlanView['groups'][number];

function render(extra: Partial<ViewGroup>): string {
  const split: SplitPlanView = {
    parentChatId: 'parent',
    triage: { at: '2026-10-13T09:00:00.000Z', received: true, repairs: [], conflicts: [] },
    order: [0],
    groups: [
      {
        index: 0,
        title: 'Ревью MR',
        branch: 'review/mr',
        after: [],
        status: 'done',
        chatId: 'c0',
        path: 'C:/copies/0',
        ...extra,
      },
    ],
  };
  const rows = new Map<string, ChildStageGroup>([
    [
      splitGroupKey({ groupIndex: 0, id: 'c0' }),
      { chatId: 'c0', title: 'Ревью MR', stages: ['review'], isRunning: false },
    ],
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildStages groups={mergeSplitGroups(rows, split)} onOpen={() => {}} />
    </QueryClientProvider>,
  );
}

afterAll(async () => {
  await i18n.changeLanguage('ru');
});

const CLOSE: NonNullable<ViewGroup['reviewClose']> = {
  at: '2026-10-13T12:00:00.000Z',
  dirt: { total: 7, files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'] },
  scratchRemoved: ['C:/wt/scratch'],
  scratchKept: [{ path: 'C:/wt/other', why: 'has uncommitted changes to tracked files' }],
  standRemoved: true,
};

describe('итог закрытия группы ревью на карточке', () => {
  it('ru: правки — тревогой с именами, остальное — строкой фактов', async () => {
    await i18n.changeLanguage('ru');
    const html = render({ reviewClose: CLOSE });
    expect(html).toContain('data-hub-review-dirt');
    expect(html).toContain('в копии изменено файлов: 7 — a.ts, b.ts, c.ts, d.ts, e.ts и ещё 2');
    // Полный список имён — по наведению.
    expect(html).toContain('title="a.ts\nb.ts\nc.ts');
    expect(html).toContain('временная копия группы убрана: C:/wt/scratch');
    expect(html).toContain(
      'временная копия осталась: C:/wt/other (has uncommitted changes to tracked files)',
    );
    expect(html).toContain('одноразовая база ревью снята');
  });

  it('en: те же факты английскими словами', async () => {
    await i18n.changeLanguage('en');
    const html = render({ reviewClose: CLOSE });
    expect(html).toContain('files changed in the copy: 7');
    expect(html).toContain('the throwaway review database was removed');
  });

  it('копия чистая и убирать нечего — ни строк, ни тревоги', async () => {
    await i18n.changeLanguage('ru');
    const html = render({});
    expect(html).not.toContain('data-hub-review-dirt');
    expect(html).not.toContain('data-hub-review-close');
  });

  it('только снятая база — без тревоги о правках', async () => {
    await i18n.changeLanguage('ru');
    const html = render({ reviewClose: { at: CLOSE.at, standRemoved: true } });
    expect(html).not.toContain('data-hub-review-dirt');
    expect(html).toContain('data-hub-review-close');
  });
});
