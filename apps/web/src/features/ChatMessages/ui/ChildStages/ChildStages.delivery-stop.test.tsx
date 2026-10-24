import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { i18n } from '@shared/config/i18n';
import { mergeSplitGroups } from '../../lib/mergeSplitGroups';
import type { ChildStageGroup } from '../ChildStages.types';
import { ChildStages } from './ChildStages';
import { splitGroupKey } from '../../lib/splitGroupKey';

type Group = SplitPlanView['groups'][number];

/**
 * Группа, остановленная на доставке, — заголовком со счётом и пунктами, а не
 * красной стеной «остановлена: доставка не доведена: …; …; …» (владелец,
 * 23.10.2026: десяток сит через «; » занимал двадцать строк, и было не понять,
 * что случилось и кто должен действовать). Рисуется настоящей карточкой хаба
 * из записи конвейера — тем же путём, что и в панели.
 */

const MISSING = [
  'сито «интеграция»: нет записи прогона — прогоните интеграционные тесты',
  'сито «чужие −»: удалены строки вне задачи в src/api/client.ts — верните их',
  'сито contract-by-request не пройдено: поле limit не описано — добавьте его в контракт',
  'сито «покрытие»: порог веток 78% ниже 80% — допишите тесты',
  'блок «Тесты» копии: 2 задетых кейса без зелёного прогона — прогоните их',
  'незакоммиченные правки: src/a.ts',
];

const group = (extra: Partial<Group> = {}): Group => ({
  index: 1,
  title: 'Лимиты',
  branch: 'feature/limits',
  after: [],
  status: 'failed',
  chatId: 'c1',
  path: 'C:/p-worktrees/feature-limits',
  error: `доставка не доведена: ${MISSING.join('; ')}`,
  errorCode: 'split-delivery-incomplete',
  errorParams: { missing: MISSING.join('; ') },
  deliveryMissing: MISSING,
  ...extra,
});

function render(item: Group): string {
  const key = splitGroupKey({ groupIndex: 1, id: '' });
  const rows = new Map<string, ChildStageGroup>([
    [key, { chatId: 'c1', title: 'Лимиты', stages: ['work'], isRunning: false }],
  ]);
  const merged = mergeSplitGroups(rows, {
    parentChatId: 'parent',
    triage: { at: '2026-10-23T10:00:00.000Z', received: true, repairs: [], conflicts: [] },
    order: [1],
    groups: [item],
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildStages groups={merged} onOpen={() => {}} />
    </QueryClientProvider>,
  );
}

const textOf = (html: string): string => html.replace(/<[^>]+>/g, '');
const itemsOf = (html: string): string[] =>
  [...html.matchAll(/<li[^>]*data-hub-delivery-item[^>]*>(.*?)<\/li>/g)].map((match) =>
    textOf(match[1] ?? ''),
  );

afterEach(async () => {
  await i18n.changeLanguage('ru');
});

describe('хаб разделения — группа, остановленная на доставке', () => {
  it('заголовок со счётом пунктов вместо стены через «; »', () => {
    const html = render(group());
    const text = textOf(html);

    expect(html).toContain('data-hub-delivery-stop');
    expect(text).toContain('Доставка остановлена — 6 пунктов');
    expect(text).not.toContain('остановлена: доставка не доведена');
    expect(text).not.toMatch(/; сито/);
  });

  it('пункты по строке: имя сита выделено, «что сделать» — своей частью; после четырёх — «ещё N»', () => {
    const html = render(group());

    expect(itemsOf(html)).toHaveLength(4);
    expect(html).toMatch(/data-hub-delivery-name[^>]*>сито «интеграция»</);
    expect(html).toMatch(/data-hub-delivery-todo[^>]*>[^<]*прогоните интеграционные тесты/);
    expect(textOf(html)).toContain('ещё 2');
    // Список не дублируется свёрнутым разделом «Не хватает для MR» в подвале.
    expect(html).not.toContain('data-hub-delivery-missing');
  });

  // F-23: остановленную группу ни один путь сервера не продолжает — «панель
  // доводит сама, от вас ничего не нужно» оставляло человека ждать вечно.
  it('остановленная группа сама не продолжит: строка — продолжить её словом, без «решение»', () => {
    for (const html of [
      render(group()),
      render(group({ cleaned: { at: '2026-10-23T11:00:00.000Z', branch: 'kept' } })),
    ]) {
      const text = textOf(html);
      expect(html).toContain('data-delivery-mode="continue"');
      expect(html).not.toContain('data-hub-delivery-human');
      expect(text).toContain('сама она не продолжит');
      expect(text).toContain('Продолжите её словом в чате группы');
      expect(text).not.toMatch(/доводит сама|ничего не нужно/);
      expect(text).not.toMatch(/решени/i);
    }
  });

  it('пункт только для человека — строкой с точным действием, остальные доводит панель', () => {
    const html = render(
      group({
        mr: 'https://forge.example.com/proj/app/-/merge_requests/123',
        deliveryMissing: [
          ...MISSING.slice(0, 2),
          'MR готов, проверки зелёные — нужен мерж MR',
          'миграция: нужно подтвердить удаление каталога data/legacy — подтвердите удаление data/legacy',
          'интеграция: нет токена доступа к трекеру — добавьте токен в настройки проекта',
        ],
      }),
    );
    const text = textOf(html);

    expect(html).toContain('data-delivery-mode="human"');
    expect(text).toContain('Доставка остановлена — 2 пункта');
    expect(text).toContain('Нужен мерж MR !123');
    expect(text).toContain('Нужно подтвердить: подтвердите удаление data/legacy');
    expect(text).toContain('Нужен доступ: добавьте токен в настройки проекта');
    expect(itemsOf(html)).toHaveLength(2);
    // Пункты человека сами называют действие — общей строки «продолжите» нет.
    expect(html).not.toContain('data-hub-delivery-who');
    expect(text).not.toMatch(/решени/i);
  });

  it('пункт только для человека по коду сервера — без разбора текста', () => {
    const html = render(
      group({
        deliveryMissing: ['ветка готова'],
        deliveryMissingCodes: [{ messageCode: 'delivery-human-merge' as never, params: {} }],
      }),
    );

    expect(html).toContain('data-hub-delivery-human="merge"');
    expect(textOf(html)).toContain('Доставка ждёт вас — 1 пункт');
  });

  it('сервер постарше без deliveryMissing — пункты из текста причины', () => {
    const html = render(
      group({
        deliveryMissing: undefined,
        error:
          'доставка не доведена: незакоммиченные правки: src/a.ts; ветка feature/limits не отправлена на удалённый',
        errorCode: undefined,
        errorParams: undefined,
      }),
    );

    expect(textOf(html)).toContain('Доставка остановлена — 2 пункта');
    expect(itemsOf(html)).toEqual([
      'незакоммиченные правки: src/a.ts',
      'ветка feature/limits не отправлена на удалённый',
    ]);
  });

  it('в английском интерфейсе — английский заголовок и подписи', async () => {
    await i18n.changeLanguage('en');
    const text = textOf(render(group()));

    expect(text).toContain('Delivery stopped — 6 items');
    expect(text).toContain('2 more items');
    expect(text).toContain('will not resume by itself');
    expect(text).not.toMatch(/finishing it itself|nothing is needed/);
    expect(text.slice(text.indexOf('Delivery stopped'))).not.toMatch(/decision/);
  });

  it('другая причина остановки — прежней строкой', () => {
    const text = textOf(
      render(
        group({ error: 'spawn claude ENOENT', errorCode: undefined, deliveryMissing: undefined }),
      ),
    );

    expect(text).toContain('остановлена: spawn claude ENOENT');
  });
});
