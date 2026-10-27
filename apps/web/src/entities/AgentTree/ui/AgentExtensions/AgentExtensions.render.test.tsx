import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentExtensions } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { ExtensionChips } from './ExtensionChips';
import { ExtensionTimeline } from './ExtensionTimeline';

/**
 * Значки узла и хронология окна «Скиллы, хуки и MCP»: что видит человек —
 * имена, итог, длительность и честное «показана только часть».
 */
describe('AgentExtensions', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });

  describe('ExtensionChips', () => {
    const summary = [
      { kind: 'skill' as const, name: 'deep-review', count: 2 },
      { kind: 'hook' as const, name: 'git-guard', count: 3, denied: 1 },
    ];

    it('без onOpen — значки без кнопки', () => {
      const html = renderToStaticMarkup(<ExtensionChips summary={summary} />);
      expect(html).not.toContain('<button');
      expect(html).toContain('deep-review ×2');
      expect(html).toContain('хуки 3');
      expect(html).toContain('отказ 1');
      expect(html).toContain('data-extension-chip="denied"');
    });

    it('с onOpen — одна кнопка с подписью для чтения с экрана', () => {
      const html = renderToStaticMarkup(
        <ExtensionChips summary={summary} onOpen={() => undefined} openLabel="агента X" />,
      );
      expect(html.match(/<button/g)).toHaveLength(1);
      expect(html).toContain('aria-label="агента X"');
    });

    it('один вызов скилла — без «×1»', () => {
      const html = renderToStaticMarkup(
        <ExtensionChips summary={[{ kind: 'skill', name: 'tdd', count: 1 }]} />,
      );
      expect(html).toContain('>tdd<');
      expect(html).not.toContain('×1');
    });

    it('пустая сводка — ничего', () => {
      expect(renderToStaticMarkup(<ExtensionChips summary={[]} />)).toBe('');
    });
  });

  describe('ExtensionTimeline', () => {
    const data: AgentExtensions = {
      agentId: 'a1',
      total: 3,
      items: [
        {
          kind: 'skill',
          name: 'deep-review',
          at: '2026-10-26T10:00:00.000Z',
          outcome: 'context',
        },
        {
          kind: 'hook',
          name: 'git-guard',
          at: '2026-10-26T10:01:00.000Z',
          durationMs: 120,
          outcome: 'denied',
          detail: 'push needs approval',
        },
        {
          kind: 'mcp',
          name: 'gitlab/get_issue',
          at: '2026-10-26T10:02:00.000Z',
          durationMs: 2500,
          outcome: 'ok',
        },
      ],
      summary: [],
    };

    it('три группы с числом, итог и длительность каждого срабатывания', () => {
      const html = renderToStaticMarkup(<ExtensionTimeline data={data} isLoading={false} />);
      expect(html).toContain('Скиллы · 1');
      expect(html).toContain('MCP · 1');
      expect(html).toContain('Хуки · 1');
      expect(html).toContain('data-extension-outcome="denied"');
      expect(html).toContain('push needs approval');
      expect(html).toContain('в контекст');
    });

    it('меньше секунды — в миллисекундах, больше — в секундах', () => {
      const html = renderToStaticMarkup(<ExtensionTimeline data={data} isLoading={false} />);
      expect(html).toContain('120 мс');
      expect(html).toContain('3с');
      expect(html).not.toContain('0с');
    });

    it('пустая группа говорит «нет»', () => {
      const one: AgentExtensions = { ...data, total: 1, items: data.items.slice(0, 1) };
      const html = renderToStaticMarkup(<ExtensionTimeline data={one} isLoading={false} />);
      expect(html).toContain('MCP · 0');
      expect(html.match(/>нет</g)).toHaveLength(2);
    });

    it('часть транскрипта и обрезанный список названы прямо', () => {
      const cut: AgentExtensions = { ...data, total: 10, partial: true };
      const html = renderToStaticMarkup(<ExtensionTimeline data={cut} isLoading={false} />);
      expect(html).toContain('data-extensions-partial');
      expect(html).toContain('Показаны последние 3 из 10');
    });

    it('целый список — без пометок о части', () => {
      const html = renderToStaticMarkup(<ExtensionTimeline data={data} isLoading={false} />);
      expect(html).not.toContain('data-extensions-partial');
      expect(html).not.toContain('data-extensions-shown');
    });

    it('читается, не нашлась и пусто — три разных состояния', () => {
      expect(renderToStaticMarkup(<ExtensionTimeline data={undefined} isLoading />)).toContain(
        'Читаю транскрипт',
      );
      expect(
        renderToStaticMarkup(<ExtensionTimeline data={undefined} isLoading={false} />),
      ).toContain('транскрипта агента нет');
      const empty: AgentExtensions = { total: 0, items: [], summary: [] };
      expect(renderToStaticMarkup(<ExtensionTimeline data={empty} isLoading={false} />)).toContain(
        'data-extensions-state="empty"',
      );
    });
  });
});
