import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { appSettingsSchema } from '@agentdeck/contracts';
import { GROUP_ECONOMY_LEVERS } from '@agentdeck/contracts/group-economy-support';
import { queryKeys } from '@shared/api/query-keys';
import { i18n } from '@shared/config/i18n';
import { GroupEconomyCard } from './GroupEconomyCard';

/**
 * Переменная `AGENTDECK_GROUP_COMPACT_WINDOW` сильнее рычага порога (F-19 ревью П1):
 * карточка называет её, иначе показывала бы порог, с которым группы не идут. И
 * «5 минут» кэша помечены как нерекомендуемые (F-24): пауза пишет окно заново.
 */

const render = (
  system: { groupCompactWindowEnv: number | null },
  settings: Record<string, unknown> = {},
): string => {
  const client = new QueryClient();
  client.setQueryData(queryKeys.system, system);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GroupEconomyCard settings={appSettingsSchema.parse(settings)} patch={() => undefined} />
    </QueryClientProvider>,
  );
};

/** Тег `<select>` числа пингов — по его выбранному варианту «3 — тёплый до…». */
const pingSelect = (html: string): string => {
  const at = html.indexOf('3 — тёплый до 3,5 ч ожидания');
  const open = html.lastIndexOf('<select', at);
  return html.slice(open, html.indexOf('>', open) + 1);
};

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('карточка экономии групп', () => {
  it('переменная панели задаёт порог — карточка называет её и число', () => {
    const html = render({ groupCompactWindowEnv: 160_000 });
    expect(html).toContain('AGENTDECK_GROUP_COMPACT_WINDOW: выбор выше не действует');
    expect(html).toContain('порогом 160 тысяч');
  });

  it('переменной нет — строки о ней нет', () => {
    expect(render({ groupCompactWindowEnv: null })).not.toContain('выбор выше не действует');
  });

  it('тёплый кэш ожидания: рычаг включён, пингов по умолчанию 3 — подпись в часах ожидания', () => {
    const html = render({ groupCompactWindowEnv: null });
    expect(html).toContain('Держать кэш тёплым, пока группа ждёт');
    expect(html).toMatch(
      /<option value="3" selected="">3 — тёплый до 3,5 ч ожидания \(рекомендуется\)/,
    );
    expect(html).toContain('<option value="1">1 — тёплый до 1,8 ч ожидания</option>');
  });

  it('тёплый кэш выключен — число пингов не выбрать; включён — выбирается', () => {
    const off = pingSelect(
      render({ groupCompactWindowEnv: null }, { groupEconomy: { keepWarm: false } }),
    );
    expect(off).toMatch(/^<select\b/);
    expect(off).toContain('disabled=""');
    const on = pingSelect(render({ groupCompactWindowEnv: null }));
    expect(on).toMatch(/^<select\b/);
    expect(on).not.toContain('disabled');
  });

  it('списка провайдеров ещё нет — строк «Где действует» нет', () => {
    expect(render({ groupCompactWindowEnv: null })).not.toContain('Где действует:');
  });

  it('«5 минут» срока кэша помечены как нерекомендуемые', () => {
    expect(render({ groupCompactWindowEnv: null })).toContain(
      '5 минут (не рекомендуется: пауза пишет окно заново)',
    );
  });
});

/**
 * План экономии чужих CLI (22.10): под каждым рычагом — где он действует, по
 * отметкам каталога CLI из `/api/providers`. Недействующий приглушён, причина —
 * текст сервера по коду в подсказке (решение O1).
 */
describe('GroupEconomyCard', () => {
  const providers = {
    active: 'claude',
    providers: [
      {
        id: 'claude',
        name: 'Claude Code',
        groupEconomy: Object.fromEntries(
          GROUP_ECONOMY_LEVERS.map((lever) => [lever, { support: 'native' }]),
        ),
      },
      {
        id: 'codex',
        name: 'Codex',
        groupEconomy: {
          compactWindow: { support: 'native' },
          cacheTtl: { support: 'impossible', note: 'economy-note-cache-implicit' },
          detachIde: { support: 'meaningless', note: 'economy-note-no-ide' },
          workHabits: { support: 'emulated' },
        },
      },
      {
        id: 'goose',
        name: 'Goose',
        groupEconomy: {
          compactWindow: { support: 'native', note: 'economy-note-window-known-only' },
          bashOutputChars: { support: 'native', note: 'economy-note-shared-tool-limit-larger' },
        },
      },
      { id: 'aider', name: 'Aider' },
    ],
  };

  const html = (): string => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.system, { groupCompactWindowEnv: null });
    client.setQueryData(queryKeys.providers, providers);
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <GroupEconomyCard settings={appSettingsSchema.parse({})} patch={() => undefined} />
      </QueryClientProvider>,
    );
  };

  /** Строка отметок одного рычага — по её `data-lever`. */
  const row = (markup: string, lever: string): string => {
    const at = markup.indexOf(`data-lever="${lever}"`);
    expect(at, lever).toBeGreaterThan(-1);
    return markup.slice(at, markup.indexOf('</div>', at));
  };

  it('renders support chips per lever', () => {
    const markup = html();
    for (const lever of GROUP_ECONOMY_LEVERS) {
      const chips = row(markup, lever);
      expect(chips, lever).toContain('Где действует:');
      expect(chips, lever).toContain('data-support="native"');
      expect(chips, lever).toContain('Claude Code');
      // Провайдер без карты рычагов не рисуется вовсе.
      expect(chips, lever).not.toContain('Aider');
    }
    expect(markup.split('data-lever=')).toHaveLength(GROUP_ECONOMY_LEVERS.length + 1);

    // Недействующий — приглушён, причина в подсказке на языке интерфейса.
    const cache = row(markup, 'cacheTtl');
    expect(cache).toContain(
      'title="Кэш у этого провайдера неявный: срок его жизни задать нельзя."',
    );
    expect(cache).toContain('Codex · нет ключа');
    expect(cache).toMatch(/class="[^"]*muted[^"]*"[^>]*data-support="impossible"/);
    expect(row(markup, 'detachIde')).toContain('Codex · не нужен');
    // Силами панели — действует, не приглушён, подсказка объясняет как.
    const habits = row(markup, 'workHabits');
    expect(habits).toContain('Codex · силами панели');
    expect(habits).not.toMatch(/class="[^"]*muted[^"]*"[^>]*data-support="emulated"/);
    // Рычаг, которого Codex не объявил, — без его отметки.
    expect(row(markup, 'keepWarm')).not.toContain('Codex');
  });

  it('состояние отметки названо словом, причина доступна чтецу текстом, а не только подсказкой', () => {
    const markup = html();
    // Родной ключ — не одним зелёным цветом: у подписи своё слово.
    expect(row(markup, 'bashOutputChars')).toContain('Claude Code · ключом CLI');
    // Причина недействующего рычага лежит текстом внутри отметки (для чтеца), не только в title.
    expect(row(markup, 'cacheTtl')).toMatch(
      /Codex · нет ключа<span class="[^"]*srOnly[^"]*">: Кэш у этого провайдера неявный/,
    );
  });

  it('действующий рычаг с условием: «с условием» словом, условие в подсказке и для чтеца, не приглушён', () => {
    const markup = html();
    const bash = row(markup, 'bashOutputChars');
    const larger =
      'Предел у CLI один на все инструменты: действует больший из двух рычагов — вывода оболочки и чтения файлов, — чтобы файл не обрезался.';
    expect(bash).toContain(`title="${larger}"`);
    expect(bash).toMatch(
      new RegExp(`Goose · ключом CLI · с условием<span class="[^"]*srOnly[^"]*">: ${larger}`),
    );
    expect(bash).toMatch(/data-support="native" data-condition=""/);
    expect(bash).not.toMatch(/class="[^"]*muted[^"]*"[^>]*data-support="native" data-condition/);
    expect(row(markup, 'compactWindow')).toContain('Goose · ключом CLI · с условием');
    // Без подсказки — без «с условием»: у Claude рычаг действует всегда.
    expect(bash).toContain('Claude Code · ключом CLI<span');
    expect(bash.split('data-condition')).toHaveLength(2);
  });
});
