import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { i18n } from '@shared/config/i18n';
import type { ChildStageGroup } from '../ChildStages.types';
import { ChildBlocks } from './ChildBlocks';

/**
 * Хаб родителя настоящей карточкой: полоса запросов детей, у которых нет своей
 * карточки, стоит НАД строками групп (аудит 25.09, L153 — под хабом из десятка
 * групп карточку права не находили).
 */

const group = (index: number): ChildStageGroup => ({
  chatId: `c${index}`,
  title: `Группа ${index}`,
  branch: `agent/g${index}`,
  stages: ['work'],
  isRunning: true,
});

function render(groups: ChildStageGroup[], withAsk: boolean): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildBlocks
        stages={groups}
        onOpenChild={() => {}}
        {...(withAsk
          ? {
              permissions: [
                {
                  chatId: 'manual-1',
                  title: 'Ручной чат',
                  permissions: [
                    { toolUseId: 'tu-1', toolName: 'Bash', input: { command: 'git push -f' } },
                  ],
                },
              ] as never,
              onPermissionDecide: () => {},
            }
          : {})}
      />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('хаб родителя: порядок и отметки', () => {
  it('полоса запросов детей — над строками хаба', () => {
    const html = render([group(0), group(1)], true);
    const asks = html.indexOf('data-child-asks');
    const hub = html.indexOf('data-child-hub');
    expect(asks).toBeGreaterThanOrEqual(0);
    expect(hub).toBeGreaterThan(asks);
  });

  it('без запросов полосы нет вовсе', () => {
    expect(render([group(0)], false)).not.toContain('data-child-asks');
  });
});
