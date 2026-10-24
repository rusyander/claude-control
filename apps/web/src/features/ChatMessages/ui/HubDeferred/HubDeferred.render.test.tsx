import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeferredAskView } from '@entities/DeferredAsk';
import type { PendingPermission } from '@shared/lib/agent-runs';
import { i18n } from '@shared/config/i18n';
import { HubDeferredView } from './HubDeferred';
import { DeferredPermissionCard } from '../PermissionCard/DeferredPermissionCard';

/**
 * Хаб разделения: раздел «Ждёт решения у групп» с фильтром по владельцу, и
 * карточка прав в ленте, отложенная по сроку, — с номером записи и без тона
 * «агент ждёт вас».
 */

function ask(id: string, groupIndex: number): DeferredAskView {
  return {
    id,
    state: 'waiting',
    kind: 'permission',
    scope: { kind: 'group', parentChatId: 'p1', groupIndex },
    toolName: 'Bash',
    summary: `psql -c "drop table t${groupIndex}"`,
    reason: 'delivery-human-destructive',
    askedAt: '2026-10-23T10:00:00.000Z',
    expiresAt: '2026-10-30T10:00:00.000Z',
    source: { group: groupIndex + 1 },
  };
}

const noop = (): void => undefined;

describe('хаб разделения: записи D-n групп', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });

  it('пусто — раздела нет', () => {
    expect(renderToStaticMarkup(<HubDeferredView items={[]} onDecide={noop} />)).toBe('');
  });

  it('записи двух групп — заголовок с числом и фишки фильтра по каждой группе', () => {
    const html = renderToStaticMarkup(
      <HubDeferredView items={[ask('D-1', 0), ask('D-2', 1), ask('D-3', 1)]} onDecide={noop} />,
    );
    expect(html).toContain('data-hub-deferred="3"');
    expect(html).toContain('Ждёт решения у групп (3)');
    expect(html).toContain('Все (3)');
    expect(html).toContain('Группа 1 (1)');
    expect(html).toContain('Группа 2 (2)');
  });
});

describe('карточка прав, отложенная как D-n', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });

  it('номер записи и спокойная подпись; кнопки ответа на месте', () => {
    const permissions: PendingPermission[] = [
      {
        toolName: 'Bash',
        input: { command: 'git push --force' },
        toolUseId: 'tu-1',
        deferredId: 'D-7',
      },
    ];
    const html = renderToStaticMarkup(
      <DeferredPermissionCard permissions={permissions} onDecide={noop} />,
    );
    expect(html).toContain('data-deferred-id="D-7"');
    expect(html).toContain('Отложено как D-7 — агент работает дальше');
    expect(html).toContain('git push --force');
    expect(html).toContain('Разрешить');
    expect(html).toContain('Запретить');
  });

  it('нет отложенных — ничего не рисуется', () => {
    expect(renderToStaticMarkup(<DeferredPermissionCard permissions={[]} onDecide={noop} />)).toBe(
      '',
    );
  });
});
