import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HumanAskSource } from '@agentdeck/contracts/core/journal';
import { i18n } from '@shared/config/i18n';
import type { AskCardAsk } from '@agentdeck/contracts/core/ask-commands';
import { AskCard } from './AskCard';

/**
 * Язык текста вопроса (этап 10, F4): вопрос сверки ядро пишет на языке задачи, как запуск и точки
 * 6–7, — у него нет `lang="en"`; вопрос модели остаётся английской прозой и помечен `lang="en"`
 * (экранный диктор читает его английским голосом).
 */

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

const ask = (source: HumanAskSource): AskCardAsk => ({
  askId: 'a1',
  point: 4,
  source,
  question: 'Действие «push» прошло?',
  options: ['Прошло', 'Не прошло', 'Проверить снова'],
  defaultAction: null,
  splitId: null,
  permit: null,
  repoKey: null,
});

function questionTag(source: HumanAskSource): string {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AskCard taskId="t1" ask={ask(source)} state="open" />
    </QueryClientProvider>,
  );
  const tag = /<[^>]*data-ask-question[^>]*>/.exec(html);
  if (!tag) throw new Error('no question element');
  return tag[0];
}

describe('AskCard question language', () => {
  it('reconcile question is in the task language: no lang="en"', () => {
    expect(questionTag('reconcile')).not.toContain('lang="en"');
  });

  it('core questions in the task language (intake, login, tracker-write): no lang="en", own badge label', () => {
    for (const source of ['intake', 'login', 'tracker-write'] as const) {
      expect(questionTag(source)).not.toContain('lang="en"');
      const html = renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <AskCard taskId="t1" ask={ask(source)} state="open" />
        </QueryClientProvider>,
      );
      expect(html).not.toContain('coreTimeline.ask.source.');
    }
  });

  it('a model question (ask_human) stays English prose: lang="en"', () => {
    expect(questionTag('ask_human')).toContain('lang="en"');
  });
});
