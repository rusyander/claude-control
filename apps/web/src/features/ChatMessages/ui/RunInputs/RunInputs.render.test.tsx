import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { i18n } from '@shared/config/i18n';
import type { ChildStageGroup } from '../ChildStages.types';
import { ChildStages } from '../ChildStages/ChildStages';
import { RunInputRuns } from './RunInputRuns';

/**
 * «Что получил агент» (U8): окно показывает вход прогона ЦЕЛИКОМ — смысл
 * сверки в дословности, — а карточка группы собирает ключ разговора звена так
 * же, как его пишет сервер: \`sessionId\` у Claude, \`<провайдер>:<id>\` у чужого.
 */

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

const GROUP: ChildStageGroup = {
  chatId: 'sess-1',
  title: 'Документация',
  stages: ['work'],
  isRunning: false,
};

function hub(groups: ChildStageGroup[], providerId?: string): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildStages
        groups={groups}
        onOpen={() => {}}
        {...(providerId ? { foreign: true, providerId } : {})}
      />
    </QueryClientProvider>,
  );
}

describe('«Что получил агент»', () => {
  it('вход в сотни килобайт показан целиком, с подписью длины', () => {
    const long = `начало ${'я'.repeat(200_000)} конец`;
    const html = renderToStaticMarkup(
      <RunInputRuns
        runs={[
          {
            startedAt: Date.parse('2026-10-12T10:00:00.000Z'),
            model: 'claude-opus-5',
            permissionMode: 'auto',
            prompt: long,
            appendSystemPrompt: 'Дописка панели',
          },
        ]}
      />,
    );

    expect(html).toContain(long);
    expect(html).toContain('Реплика');
    expect(html).toContain('Дописка к системному промпту');
    expect(html).toContain('Дописка панели');
    expect(html).toContain('Модель: claude-opus-5');
    // Глубины не было — решал CLI, и так и написано, а не пусто.
    expect(html).toContain('Глубина: настройка CLI');
    // Раздела без текста нет: промпта контура у прогона не было.
    expect(html).not.toContain('Системный промпт контура');
  });

  it('кнопка у группы Claude — с ключом sessionId', () => {
    expect(hub([GROUP])).toContain('data-received-open="sess-1"');
  });

  it('кнопка у группы чужого CLI — с ключом связи «провайдер:id»', () => {
    expect(hub([GROUP], 'codex')).toContain('data-received-open="codex:sess-1"');
  });

  it('у группы без чата кнопки нет: прогонов ещё не было', () => {
    const waiting: ChildStageGroup = { ...GROUP, chatId: '', pending: 'waiting', groupIndex: 1 };
    expect(hub([waiting])).not.toContain('data-received-open');
  });
});
