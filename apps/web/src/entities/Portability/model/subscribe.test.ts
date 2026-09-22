import { describe, expect, it } from 'vitest';
import { envItemKinds, type EnvItemKind } from '@agentdeck/contracts/portable-env';
import type { EnvSubscription, SubscriptionRow } from '@agentdeck/contracts/portable-subscribe';
import { KIND_ORDER } from './passport';
import {
  ROW_STATE_ORDER,
  ROW_STATE_TONE,
  findSubscription,
  hasLayers,
  isLayerOn,
  summarizeRows,
  toggleLayer,
} from './subscribe';

const row = (
  itemId: string,
  state: SubscriptionRow['state'],
  heldBy: string | null = null,
): SubscriptionRow => ({ itemId, kind: 'skill', state, heldBy });

const subscription = (
  target: string,
  scope: 'global' | 'project',
  layers: EnvItemKind[],
  project?: string,
): EnvSubscription => ({
  target,
  scope,
  ...(project ? { project } : {}),
  layers,
  canonVersion: 1,
  marks: {},
  files: {},
  root: null,
  syncedAt: null,
});

describe('порядок и цвета состояний', () => {
  it('накрывает каждое состояние контракта', () => {
    // Состояние, добавленное в контракт и забытое здесь, обязано быть видно
    // тестом, а не серой меткой на экране.
    expect([...ROW_STATE_ORDER].sort()).toEqual(Object.keys(ROW_STATE_TONE).sort());
  });

  it('показывает совпавшие последними, а меняющееся — первым', () => {
    expect(ROW_STATE_ORDER.at(-1)).toBe('unchanged');
    expect(ROW_STATE_ORDER[0]).toBe('new');
  });

  it('красит исчезнувшую запись предупреждением, а не бедой', () => {
    // `gone` — разговор: запись ушла из канона, у цели осталась, и снимать её
    // подписка не умеет. Красное обещало бы отказ, которого нет.
    expect(ROW_STATE_TONE.gone).toBe('warning');
  });
});

describe('сводка строк', () => {
  it('считает состояния из строк', () => {
    const summary = summarizeRows([
      row('a', 'new'),
      row('b', 'changed'),
      row('c', 'changed'),
      row('d', 'unchanged'),
      row('e', 'gone'),
    ]);
    expect(summary.counts).toEqual({ new: 1, changed: 2, unchanged: 1, gone: 1 });
  });

  it('считает удержанное ОТДЕЛЬНО от состояния', () => {
    // Удержание — ответ про диск, состояние — ответ про канон. Сложи их в одно
    // число, и «изменилась, но не поедет» прочиталось бы как «записана».
    const summary = summarizeRows([row('a', 'changed'), row('b', 'changed', 'settings.json')]);
    expect(summary.counts.changed).toBe(2);
    expect(summary.held).toBe(1);
  });

  it('у пустого списка отвечает нулями, а не пустым объектом', () => {
    // Ноль показывается наравне с числом: отсутствие метки человек читает как
    // «такого здесь не бывает».
    expect(summarizeRows([]).counts).toEqual({ new: 0, changed: 0, unchanged: 0, gone: 0 });
  });
});

describe('поиск подписки', () => {
  const items = [
    subscription('codex', 'global', ['skill']),
    subscription('codex', 'project', ['hook'], 'p1'),
    subscription('gemini', 'global', ['mcpServer']),
  ];

  it('различает дом и проект одной цели', () => {
    expect(findSubscription(items, 'codex', 'global')?.layers).toEqual(['skill']);
    expect(findSubscription(items, 'codex', 'project', 'p1')?.layers).toEqual(['hook']);
  });

  it('не выдаёт подписку другого проекта за подписку этого', () => {
    // Разные корни: показать одну под заголовком другой значило бы предложить
    // пересобрать не те файлы.
    expect(findSubscription(items, 'codex', 'project', 'p2')).toBeNull();
  });

  it('не выдаёт подписку дома за подписку проекта', () => {
    expect(findSubscription(items, 'gemini', 'project', 'p1')).toBeNull();
  });

  it('отвечает null, а не undefined, когда подписки нет', () => {
    expect(findSubscription(items, 'aider', 'global')).toBeNull();
  });
});

describe('подписанные слои', () => {
  it('отписанную запись подпиской не считает', () => {
    // Запись переживает отписку намеренно: в ней память о спроецированном.
    // Считать её наличие подпиской значило бы предлагать пересборку тому, кто
    // от всего отписался.
    expect(hasLayers(subscription('codex', 'global', []))).toBe(false);
    expect(hasLayers(subscription('codex', 'global', ['skill']))).toBe(true);
    expect(hasLayers(null)).toBe(false);
  });

  it('у отсутствующей подписки каждый слой выключен', () => {
    expect(isLayerOn(null, 'skill')).toBe(false);
  });
});

describe('переключение слоя', () => {
  it('добавляет и снимает', () => {
    expect(toggleLayer(['skill'], 'hook', KIND_ORDER)).toEqual(['skill', 'hook']);
    expect(toggleLayer(['skill', 'hook'], 'skill', KIND_ORDER)).toEqual(['hook']);
  });

  it('держит порядок словаря, а не порядок щелчков', () => {
    // Два одинаковых набора, отличающиеся порядком, выглядят разными подписками
    // в каждом сравнении — сервер хранит список как есть.
    const clicked = toggleLayer(['hook'], 'skill', KIND_ORDER);
    expect(clicked).toEqual(['skill', 'hook']);
    expect(KIND_ORDER.indexOf('skill')).toBeLessThan(KIND_ORDER.indexOf('hook'));
  });

  it('не плодит дубль при повторном включении', () => {
    const once = toggleLayer([], 'skill', KIND_ORDER);
    expect(toggleLayer(once, 'skill', KIND_ORDER)).toEqual([]);
  });

  it('порядок экрана ПОЛОН по словарю канона', () => {
    // Список ниже решает не только вид экрана: по нему же пересобирается набор
    // подписанных слоёв. Забытый в нём вид исчезал бы из подписки при первом
    // щелчке по соседнему — поэтому полнота проверяется, а не обещается словами.
    expect([...KIND_ORDER].sort()).toEqual([...envItemKinds].sort());
  });

  it('вид, которого нет в порядке экрана, из подписки не исчезает', () => {
    const forgotten = KIND_ORDER.filter((kind) => kind !== 'hook');
    expect(toggleLayer(['hook'], 'skill', forgotten)).toEqual(['skill', 'hook']);
  });
});
