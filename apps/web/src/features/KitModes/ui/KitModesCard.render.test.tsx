import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { KitProviderView } from '@agentdeck/contracts/kit';
import { i18n } from '@shared/config/i18n';
import { KitModesCard } from './KitModesCard';

/**
 * «Где действуют хуки набора»: строка на способ, CLI перечислены в ней. Режим и хуки доходят
 * по-разному — у Codex режим есть, а хуки только вариантом руками; без строки человек
 * читал бы «Ваши и набор панели» у Codex как «охрана набора действует».
 */

const view = (id: string, title: string, extra: Partial<KitProviderView>): KitProviderView => ({
  id,
  title,
  mode: 'global',
  modes: [],
  ...extra,
});

const PROVIDERS: KitProviderView[] = [
  view('claude', 'Claude Code', { modes: ['global', 'hybrid', 'ours'], hooks: 'run' }),
  view('codex', 'Codex', { modes: ['global', 'hybrid'], hooks: 'variant' }),
  view('goose', 'Goose', { reason: 'no-run-layer', hooks: 'variant' }),
  view('continue', 'Continue', { reason: 'no-run-layer', hooks: 'never-fire' }),
  view('aider', 'Aider', { reason: 'no-run-layer', hooks: 'no-tool-loop' }),
];

const render = (providers: KitProviderView[]): string =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <KitModesCard providers={providers} />
    </QueryClientProvider>,
  );

/** Текст строки `data-reach` (без тегов). */
const line = (html: string, reach: string): string | undefined =>
  html.match(new RegExp(`data-reach="${reach}"[^>]*>([^<]*)<`))?.[1]?.replace(/&#x27;/g, "'");

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('карточка «Кто получает набор»: где действуют хуки', () => {
  it('строка на способ, CLI — в своей строке, порядок от «действуют» к «не действуют»', () => {
    const html = render(PROVIDERS);
    expect(html).toContain('Где действуют хуки набора (экономия и охрана):');
    expect(line(html, 'run')).toBe('на каждом запуске — Claude Code;');
    expect(line(html, 'variant')).toMatch(/^вариантом, который ставите вы, — Codex, Goose:/);
    expect(line(html, 'never-fire')).toMatch(/^не действуют — Continue: формат хуков у CLI есть/);
    expect(line(html, 'no-tool-loop')).toMatch(/^не действуют — Aider:/);
    expect(line(html, 'not-runnable')).toBeUndefined();
    const order = ['run', 'variant', 'never-fire', 'no-tool-loop'].map((r) =>
      html.indexOf(`data-reach="${r}"`),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('ни у кого нет отметки хуков — блока нет', () => {
    const html = render(PROVIDERS.map(({ hooks: _hooks, ...rest }) => rest));
    expect(html).not.toContain('data-kit-hooks');
  });

  it('английский словарь — те же строки', async () => {
    await i18n.changeLanguage('en');
    try {
      const html = render(PROVIDERS);
      expect(html).toContain('Where the kit hooks act (economy and safety):');
      expect(line(html, 'variant')).toMatch(/^through a variant you install — Codex, Goose:/);
    } finally {
      await i18n.changeLanguage('ru');
    }
  });
});
