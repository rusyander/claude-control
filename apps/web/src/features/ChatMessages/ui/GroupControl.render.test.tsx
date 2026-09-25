import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { i18n } from '@shared/config/i18n';
import { mergeSplitGroups, splitGroupKey } from '../lib/mergeSplitGroups';
import type { ChildStageGroup } from './ChildStages.types';
import { ChildStages } from './ChildStages';

type Group = SplitPlanView['groups'][number];

const group = (index: number, extra: Partial<Group> = {}): Group => ({
  index,
  title: `Группа ${index}`,
  branch: `agent/g${index}`,
  after: [],
  status: 'pending',
  ...extra,
});

/**
 * Строка хаба с кнопкой группы целиком: склейка конвейера (`mergeSplitGroups`)
 * рисуется настоящей карточкой `ChildStages` под клиентом запросов — так, как
 * её видит человек (журнал 81, 89). До правки срок лимита шёл сырым ключом
 * перевода, а кнопок у группы не было вовсе.
 */
function render(rows: Map<string, ChildStageGroup>, split: SplitPlanView): string {
  const groups = mergeSplitGroups(rows, split);
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildStages groups={groups} onOpen={() => {}} />
    </QueryClientProvider>,
  );
}

const textOf = (html: string): string => html.replace(/<[^>]+>/g, '|');

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('хаб разделения — управление группой', () => {
  it('ждущая места группа: «Запустить сейчас» и срок лимита очереди человеческим текстом', () => {
    const html = render(new Map(), {
      parentChatId: 'parent',
      triage: { at: '2026-09-25T10:00:00.000Z', received: true, repairs: [], conflicts: [] },
      order: [0],
      groups: [group(0)],
      limitUntil: '2026-09-25T18:00:00.000Z',
    });
    expect(html).toContain('data-group-control="start"');
    expect(html).toContain('data-limit-until="2026-09-25T18:00:00.000Z"');
    expect(textOf(html)).toContain('|Запустить сейчас|');
    expect(textOf(html)).toMatch(/ждёт лимита до \d{2}:\d{2}/);
    expect(html).not.toContain('chat.cascade.hub');
  });

  it('работающая группа — «Пауза», остановленная — «Продолжить»', () => {
    const key = (index: number): string => splitGroupKey({ groupIndex: index, id: '' });
    const html = render(
      new Map<string, ChildStageGroup>([
        [key(1), { chatId: 'c1', title: 'Группа 1', stages: ['work'], isRunning: true }],
        [key(2), { chatId: 'c2', title: 'Группа 2', stages: ['work'], isRunning: false }],
      ]),
      {
        parentChatId: 'parent',
        triage: { at: '2026-09-25T10:00:00.000Z', received: true, repairs: [], conflicts: [] },
        order: [1, 2],
        groups: [group(1, { status: 'started' }), group(2, { status: 'paused' })],
      },
    );
    expect(html).toContain('data-group-control="pause"');
    expect(html).toContain('data-group-control="resume"');
    expect(textOf(html)).toContain('|Пауза|');
    expect(textOf(html)).toContain('|Продолжить|');
    expect(html).not.toContain('chat.cascade.hub');
  });
});
