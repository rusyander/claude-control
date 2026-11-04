import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { i18n } from '@shared/config/i18n';
import type { ChildStageGroup } from '../ChildStages.types';
import { ChildStages } from '../ChildStages/ChildStages';

const BRANCH = 'fix-PROJ-1459-PROJ-1444-PROJ-1402-PROJ-1399-PROJ-1362/docs-fixes';

const GROUP: ChildStageGroup = {
  chatId: 'c0',
  title: 'Документация',
  branch: BRANCH,
  stages: ['work'],
  isRunning: false,
};

/**
 * Карточка группы (владелец 05.10.2026): кнопки — внутри неё, над растянутой
 * кнопкой «открыть чат»; ветка — одной строкой с подсказкой. Рисуется настоящей
 * сводкой `ChildStages`, как её видит человек. Кнопки MR у карточки больше нет —
 * её ставил снятый конвейер разделения (этап 10, G14).
 */
function render(groups: ChildStageGroup[] = [GROUP]): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildStages groups={groups} onOpen={() => {}} />
    </QueryClientProvider>,
  );
}

/** Кусок разметки от открывающего тега с атрибутом до его закрытия того же тега. */
function element(html: string, attr: string, tag: string): string {
  const at = html.indexOf(attr);
  if (at < 0) return '';
  const start = html.lastIndexOf(`<${tag}`, at);
  return html.slice(start, html.indexOf(`</${tag}>`, at) + tag.length + 3);
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('карточка группы в хабе', () => {
  it('название — в растянутой кнопке «открыть чат», кнопки MR нет', () => {
    const html = render();
    const open = element(html, 'data-hub-open', 'button');
    expect(open).toContain('Документация');
    expect(open).not.toContain('<a ');
    expect(html).not.toContain('data-hub-mr');
  });

  it('кнопки группы — внутри её карточки, после её шапки', () => {
    const html = render([GROUP, { ...GROUP, chatId: 'c1', title: 'Вторая' }]);
    const first = html.indexOf('data-hub-row="chat"');
    const second = html.indexOf('data-hub-row="chat"', first + 1);
    const button = html.indexOf('data-received-open="c0"');
    expect(button).toBeGreaterThan(html.indexOf('Документация'));
    expect(button).toBeLessThan(second);
  });

  it('карточка без вопроса — без полосы «ждёт вас»; с вопросом — в корзине «ask»', () => {
    expect(render()).toContain('data-hub-bucket="idle"');
    const html = render([{ ...GROUP, waitingFor: 'question' }]);
    expect(html).toContain('data-hub-bucket="ask"');
    expect(html).toContain('data-hub-waiting="question"');
  });

  // Владелец 22.10.2026: «план › работа › работа › работа» читался кашей, и
  // текущее звено терялось в конце строки.
  it('путь группы: повторы подряд — счётом, текущее звено — своей фишкой', () => {
    const html = render([
      { ...GROUP, stages: ['plan', 'work', 'work', 'work', 'review'], isRunning: true },
    ]);
    const from = html.indexOf('data-hub-stages');
    const stages = html
      .slice(from, html.indexOf('</span></span>', from))
      .replace(/^[^>]*>/, '')
      .replace(/<[^>]+>/g, '|');
    expect(stages).toBe('|план ›||работа ×3 ›||сейчас: ревью');
    expect(html).toContain('data-hub-stage-current="review"');
    expect(html).not.toContain('работа › работа');
  });

  it('ветка — одной строкой, текст целиком в разметке', () => {
    const html = render();
    expect(html).toContain(BRANCH);
    const branch = element(html, BRANCH, 'span');
    expect(branch).toMatch(/truncate/);
  });
});
