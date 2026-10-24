import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeferredAskView } from '@entities/DeferredAsk';
import { i18n } from '@shared/config/i18n';
import { DeferredAsksBannerView } from './DeferredAsksBanner';

/**
 * Плашка «Ждёт решения (n)»: число — только ждущие записи, раскрытый список
 * показывает и истёкшие (их можно разрешить заново), решённых нет. Пусто —
 * плашки нет вовсе, иначе она висела бы над каждым разделом без дела.
 */

function ask(id: string, extra: Partial<DeferredAskView> = {}): DeferredAskView {
  return {
    id,
    state: 'waiting',
    kind: 'permission',
    scope: { kind: 'group', parentChatId: 'p1', groupIndex: 1 },
    toolName: 'Bash',
    summary: `npm publish ${id}`,
    reason: 'delivery-human-destructive',
    askedAt: '2026-10-23T10:00:00.000Z',
    expiresAt: '2026-10-30T10:00:00.000Z',
    source: { group: 2, groupTitle: 'Релиз' },
    ...extra,
  };
}

const noop = (): void => undefined;

describe('плашка «Ждёт решения»', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });

  it('нет ждущих записей — плашки нет, даже если есть решённые и истёкшие', () => {
    const html = renderToStaticMarkup(
      <DeferredAsksBannerView
        items={[ask('D-1', { state: 'allowed' }), ask('D-2', { state: 'expired' })]}
        onDecide={noop}
      />,
    );
    expect(html).toBe('');
  });

  it('число — ждущие; список — ждущие и истёкшие, без решённых', () => {
    const html = renderToStaticMarkup(
      <DeferredAsksBannerView
        items={[
          ask('D-1'),
          ask('D-2', { state: 'expired' }),
          ask('D-3', { state: 'denied' }),
          ask('D-4'),
        ]}
        onDecide={noop}
        defaultOpen
      />,
    );
    expect(html).toContain('data-deferred-banner="2"');
    expect(html).toContain('Ждёт решения (2)');
    expect(html).toContain('npm publish D-1');
    expect(html).toContain('npm publish D-2');
    expect(html).toContain('npm publish D-4');
    expect(html).not.toContain('npm publish D-3');
    expect(html).toContain('Разрешить заново');
  });

  it('свёрнута по умолчанию — список не рисуется, пока человек не раскроет', () => {
    const html = renderToStaticMarkup(
      <DeferredAsksBannerView items={[ask('D-1')]} onDecide={noop} />,
    );
    expect(html).toContain('Ждёт решения (1)');
    expect(html).not.toContain('npm publish D-1');
  });

  // Живой прогон 23.10: причина для агента (англ.) стояла в русской плашке.
  it('причина — на языке панели по коду записи, английский текст агента не виден', () => {
    const html = renderToStaticMarkup(
      <DeferredAsksBannerView
        items={[
          ask('D-1', {
            reason: "the group's permission rows send this call to the human",
            reasonCode: 'group-rows',
          }),
          ask('D-2', {
            reason: 'backend guard prod-target: prod.example.com',
            reasonCode: 'backend-guard',
            reasonParams: { rule: 'prod-target', match: 'prod.example.com' },
          }),
          ask('D-3', { reason: 'a reason without a code' }),
        ]}
        onDecide={noop}
        defaultOpen
      />,
    );
    expect(html).toContain('Правила прав группы отдают этот вызов человеку.');
    expect(html).not.toContain('permission rows');
    expect(html).toContain('Защита бэкенда: команда обращается к проду — «prod.example.com».');
    expect(html).not.toContain('backend guard prod-target');
    // Запись старше кода — её текст как есть, а не пустая строка.
    expect(html).toContain('a reason without a code');
  });
});
