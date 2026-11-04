import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConfigView } from '@agentdeck/contracts/core/config';
import { GROUP_ECONOMY_LEVERS } from '@agentdeck/contracts/group-economy-support';
import { queryKeys } from '@shared/api/query-keys';
import { i18n } from '@shared/config/i18n';
import { CoreEconomyCard } from './CoreEconomyCard';

/**
 * @covers pages/Settings/CoreEconomyCard/CoreEconomyCard.tsx
 * @scenario карточка «Экономия шагов задачи» (порт карточки «Экономия групп разделения», этап 10,
 *   G15) рисует шесть рычагов раздела `economy` настройки ядра с текущими значениями и отметками
 *   «Где действует»; ядро недоступно — говорит это словами панели и не рисует рычагов.
 */

const CONFIG: ConfigView = {
  doc: { economy: { compactWindow: 160_000, bashOutputChars: 0, workHabits: false } },
  digest: 'd1',
  drift: null,
  issues: [],
};

const PROVIDERS = {
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

const render = (seed: (client: QueryClient) => void): string => {
  // retryOnMount: false — иначе разметка без браузера рисует засеянную ошибку как новую загрузку.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  seed(client);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CoreEconomyCard />
    </QueryClientProvider>,
  );
};

/** Выбранный вариант `<select>`, следующего за подписью поля. */
const selected = (html: string, label: string): string => {
  const at = html.indexOf(label);
  expect(at, label).toBeGreaterThan(-1);
  const open = html.indexOf('<select', at);
  const close = html.indexOf('</select>', open);
  const option = /<option value="([^"]*)" selected="">/.exec(html.slice(open, close));
  return option?.[1] ?? '';
};

/** Строка отметок одного рычага — по её `data-lever`. */
const row = (markup: string, lever: string): string => {
  const at = markup.indexOf(`data-lever="${lever}"`);
  expect(at, lever).toBeGreaterThan(-1);
  return markup.slice(at, markup.indexOf('</div>', at));
};

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('CoreEconomyCard', () => {
  it('shows the core values: set ones as set, missing ones as the core default', () => {
    const html = render((client) => client.setQueryData(queryKeys.core.config, CONFIG));
    expect(html).toContain('Экономия шагов задачи');
    expect(html).toContain('data-core-economy="ready"');
    expect(selected(html, 'Порог сжатия контекста шага')).toBe('160000');
    expect(selected(html, 'Ответ команды в разговоре')).toBe('0');
    // Поля нет — умолчание ядра, помечено «рекомендуется».
    expect(selected(html, 'Одно чтение файла')).toBe('10000');
    expect(html).toContain('<option value="10000" selected="">10 тысяч токенов (рекомендуется)');
    expect(selected(html, 'Срок кэша разговора')).toBe('');
    // Выключенные привычки — тумблер выключен, редактор — включён (умолчание).
    expect(html).toMatch(
      /aria-label="Экономные привычки агента"[^>]*aria-checked="false"|aria-checked="false"[^>]*aria-label="Экономные привычки агента"/,
    );
    expect(html).toMatch(
      /aria-label="Не подключать шаги к редактору"[^>]*aria-checked="true"|aria-checked="true"[^>]*aria-label="Не подключать шаги к редактору"/,
    );
  });

  it('no retired lever is drawn: delivery model, fresh conversation, warm cache, pings', () => {
    const html = render((client) => client.setQueryData(queryKeys.core.config, CONFIG));
    for (const gone of [
      'Sonnet',
      'Новый разговор после',
      'кэш тёплым',
      'Пингов',
      'AGENTDECK_GROUP_COMPACT_WINDOW',
    ]) {
      expect(html, gone).not.toContain(gone);
    }
  });

  it('draws «Где действует» per lever from the provider catalogs', () => {
    const html = render((client) => {
      client.setQueryData(queryKeys.core.config, CONFIG);
      client.setQueryData(queryKeys.providers, PROVIDERS);
    });
    for (const lever of GROUP_ECONOMY_LEVERS) {
      expect(row(html, lever), lever).toContain('Claude Code · ключом CLI');
      expect(row(html, lever), lever).not.toContain('Aider');
    }
    expect(html.split('data-lever=')).toHaveLength(GROUP_ECONOMY_LEVERS.length + 1);
    // Недействующий — приглушён, причина в подсказке на языке интерфейса.
    const cache = row(html, 'cacheTtl');
    expect(cache).toContain('Codex · нет ключа');
    expect(cache).toContain(
      'title="Кэш у этого провайдера неявный: срок его жизни задать нельзя."',
    );
    expect(cache).toMatch(/class="[^"]*muted[^"]*"[^>]*data-support="impossible"/);
    expect(row(html, 'detachIde')).toContain('Codex · не нужен');
    // Силами панели — действует, не приглушён.
    const habits = row(html, 'workHabits');
    expect(habits).toContain('Codex · силами панели');
    expect(habits).not.toMatch(/class="[^"]*muted[^"]*"[^>]*data-support="emulated"/);
  });

  it('support state is a word, the reason is text for a screen reader, not only a tooltip', () => {
    const html = render((client) => {
      client.setQueryData(queryKeys.core.config, CONFIG);
      client.setQueryData(queryKeys.providers, PROVIDERS);
    });
    expect(row(html, 'cacheTtl')).toMatch(
      /Codex · нет ключа<span class="[^"]*srOnly[^"]*">: Кэш у этого провайдера неявный/,
    );
  });

  it('a lever that acts with a condition: «с условием» as a word, condition in tooltip and for the reader, not muted', () => {
    const html = render((client) => {
      client.setQueryData(queryKeys.core.config, CONFIG);
      client.setQueryData(queryKeys.providers, PROVIDERS);
    });
    const bash = row(html, 'bashOutputChars');
    const larger =
      'Предел у CLI один на все инструменты: действует больший из двух рычагов — вывода оболочки и чтения файлов, — чтобы файл не обрезался.';
    expect(bash).toContain(`title="${larger}"`);
    expect(bash).toMatch(
      new RegExp(`Goose · ключом CLI · с условием<span class="[^"]*srOnly[^"]*">: ${larger}`),
    );
    expect(bash).not.toMatch(/class="[^"]*muted[^"]*"[^>]*data-support="native" data-condition/);
    expect(row(html, 'compactWindow')).toContain('Goose · ключом CLI · с условием');
    // Без подсказки — без «с условием»: у Claude рычаг действует всегда.
    expect(bash).toContain('Claude Code · ключом CLI<span');
    expect(bash.split('data-condition')).toHaveLength(2);
  });

  it('no provider list yet — no «Где действует» rows; 5 minutes of cache marked not recommended', () => {
    const html = render((client) => client.setQueryData(queryKeys.core.config, CONFIG));
    expect(html).not.toContain('Где действует:');
    expect(html).toContain('5 минут (не рекомендуется: пауза пишет окно заново)');
  });

  it('names a rejected economy section', () => {
    const html = render((client) =>
      client.setQueryData(queryKeys.core.config, {
        ...CONFIG,
        issues: [{ section: 'economy', reason: 'bashOutputChars: too small' }],
      }),
    );
    expect(html).toContain('ядро его не применяет: bashOutputChars: too small');
  });

  it('core unavailable — says so in panel words and draws no levers', () => {
    const html = render((client) => {
      const query = client.getQueryCache().build(client, { queryKey: queryKeys.core.config });
      query.setState({
        status: 'error',
        fetchStatus: 'idle',
        // Отказ прокладки, как его отдаёт axios: 503 с кодом в теле.
        error: Object.assign(new Error('Request failed with status code 503'), {
          response: { status: 503, data: { code: 'core-unreachable' } },
        }),
      });
    });
    expect(html).toContain('data-core-economy="unavailable"');
    expect(html).toContain('Рычаги хранит ядро задач, а оно недоступно: Ядро не отвечает.');
    expect(html).not.toContain('<select');
  });
});
