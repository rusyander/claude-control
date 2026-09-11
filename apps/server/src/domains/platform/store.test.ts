import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store.ts';
import { getStoredKey, setStoredKey } from '../../lib/provider-keys.ts';
import { checkPlatform } from './check.ts';
import {
  describePlatform,
  describePlatforms,
  forgetOrphanPlatforms,
  readPlatforms,
  readToken,
  removePlatform,
  requireConnected,
  requirePlatform,
  tokenId,
  writePlatform,
  writeToken,
} from './store.ts';

/**
 * Хранилище контуров: настройка видна, КЛЮЧ НЕ ВИДЕН НИКОМУ.
 *
 * Главная проверка файла — последняя группа: сохранённый ключ не должен
 * появиться ни в одном ответе панели, ни в `state.json`. Это то единственное
 * свойство, ради которого секреты вынесены в отдельное зашифрованное хранилище,
 * и первый инвариант партии.
 */

/**
 * Ключ-подстановка. Латиница обязательна: с Т12 ключ вне печатного ASCII панель
 * не сохраняет вовсе — он не уйдёт в заголовке `Authorization`. Строка при этом
 * остаётся приметной, чтобы утечка в файл или в ответ находилась поиском.
 */
const SECRET = 'CONTOUR-KEY-CORPORATE-4f21';

const PLATFORM: Platform = {
  id: 'enterprise-platform-dev',
  title: 'EnterprisePlatform · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 100,
  capabilities: [],
  targets: ['assistant'],
  projectPaths: [],
  agents: [],
  budgetSince: '',
  caCertPath: '',
};

let dir: string;
let store: AppStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-platform-'));
  store = new AppStore(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Всё, что панель записала на диск, одной строкой — для поиска утечки. */
function everythingOnDisk(root: string): string {
  const parts: string[] = [];
  const walk = (path: string): void => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else parts.push(readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return parts.join('\n');
}

describe('domains/platform/store: контуры и ключи', () => {
  it('пока контуров нет, список пуст — и это не ошибка', () => {
    expect(describePlatforms(store, dir)).toEqual([]);
  });

  it('сохранённый контур виден целиком, кроме ключа', () => {
    writePlatform(store, PLATFORM);
    writeToken(dir, PLATFORM.id, SECRET);

    const card = describePlatforms(store, dir)[0]!;
    expect(card.platform.title).toBe('EnterprisePlatform · dev');
    expect(card.hasToken).toBe(true);
    expect(card.maskedToken).not.toBe(SECRET);
    expect(card.maskedToken).toContain('…');
    expect(JSON.stringify(card)).not.toContain(SECRET);
  });

  // Настроенный до Т7 контур поля `agents` не знает: файл настроек — источник
  // истины, и старую запись никто не переписывает. Тип обещает массив, обещание
  // не выполняется, и карточка агентов уронила бы весь раздел на `agents.length`.
  it('у контура, настроенного до появления агентов, список пуст, а не отсутствует', () => {
    const older = { ...PLATFORM } as Partial<Platform>;
    delete older.agents;
    store.updateSettings({ platforms: [older as Platform] });

    expect(describePlatforms(store, dir)[0]!.platform.agents).toEqual([]);
  });

  // Та же беда для полей Т8, найдена враждебным ревью: `budgetVerdict` кладёт
  // бюджет в поле, которое контракт обещает числом, а полоса сравнивается с
  // ним — `undefined` дал бы шкалу без предела и «нет» при любом расходе.
  it('у контура, настроенного до появления бюджета, поля приведены, а не пусты', () => {
    const older = { ...PLATFORM } as Partial<Platform>;
    delete older.budgetUsd;
    delete older.budgetSince;
    store.updateSettings({ platforms: [older as Platform] });

    const card = describePlatforms(store, dir)[0]!;
    expect(card.platform.budgetUsd).toBe(0);
    expect(card.platform.budgetSince).toBe('');
    expect(card.budget.tracked).toBe(false);
  });

  it('повторная запись заменяет контур на месте, а не плодит второй', () => {
    writePlatform(store, PLATFORM);
    writePlatform(store, { ...PLATFORM, title: 'EnterprisePlatform · prod' });

    const list = describePlatforms(store, dir);
    expect(list).toHaveLength(1);
    expect(list[0]!.platform.title).toBe('EnterprisePlatform · prod');
  });

  it('ключ живёт под своим пространством имён', () => {
    expect(tokenId('enterprise-platform-dev')).toBe('platform:enterprise-platform-dev');
  });

  it('пустая строка стирает ключ — это осознанное «выкинуть»', () => {
    writePlatform(store, PLATFORM);
    writeToken(dir, PLATFORM.id, SECRET);
    expect(readToken(dir, PLATFORM.id)).toBe(SECRET);

    writeToken(dir, PLATFORM.id, '');
    expect(readToken(dir, PLATFORM.id) ?? '').toBe('');
    expect(describePlatform(store, dir, PLATFORM).hasToken).toBe(false);
  });

  it('ключ короче порога чистки не сохраняется вовсе', () => {
    // Порог парный с `redactSecrets`: тот вырезает ключ по значению только с
    // восьми символов (подстрока в шесть резала бы осмысленный текст). Ключ
    // короче прошёл бы чистку насквозь и уехал бы на экран, отрази его контур в
    // тексте своей ошибки.
    expect(() => writeToken(dir, PLATFORM.id, 'sk-live')).toThrow(/короче/);
    expect(readToken(dir, PLATFORM.id)).toBeUndefined();
  });

  it('ключ с кириллицей не сохраняется: он не уйдёт в заголовке', () => {
    // Найдено живым прогоном на чужом шлюзе (Т12): такой ключ доходил до
    // транспорта, и человек читал «Нет связи с контуром: Cannot convert
    // argument to a ByteString…» — то есть шёл чинить сеть вместо ключа.
    // Так выглядит подпись, скопированная вместе с ключом из письма.
    expect(() => writeToken(dir, PLATFORM.id, 'sk-live-ключ')).toThrow(/вне латиницы/);
    expect(readToken(dir, PLATFORM.id)).toBeUndefined();

    // Обычный ключ по-прежнему сохраняется — проверка не должна отсечь живое.
    writeToken(dir, PLATFORM.id, SECRET);
    expect(readToken(dir, PLATFORM.id)).toBe(SECRET);
  });

  it('несуществующий контур — 404 с его именем, а не пустой ответ', () => {
    expect(() => requirePlatform(store, 'нет-такого')).toThrow(/нет-такого/);
  });

  it('выключенный контур не считается подключённым', () => {
    writePlatform(store, { ...PLATFORM, enabled: false });
    writeToken(dir, PLATFORM.id, SECRET);
    expect(() => requireConnected(store, dir, PLATFORM.id)).toThrow(/не подключён/);
  });

  it('включённый без ключа — тоже не подключён', () => {
    writePlatform(store, PLATFORM);
    expect(() => requireConnected(store, dir, PLATFORM.id)).toThrow(/не подключён/);
  });

  it('удаление уносит настройку, ключ и след пробы', async () => {
    writePlatform(store, PLATFORM);
    writeToken(dir, PLATFORM.id, SECRET);
    await checkPlatform(store, dir, PLATFORM.id, () =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: 'gpt-4o', kind: 'chat' }] }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    expect(store.getPlatformHealth()[PLATFORM.id]).toBeDefined();

    removePlatform(store, dir, PLATFORM.id);

    expect(describePlatforms(store, dir)).toEqual([]);
    expect(readToken(dir, PLATFORM.id) ?? '').toBe('');
    expect(store.getPlatformHealth()[PLATFORM.id]).toBeUndefined();
  });
});

describe('уборка сирот: секрет без владельца не остаётся', () => {
  it('контур, исчезнувший из настроек мимо маршрута, уносит ключ и след пробы', async () => {
    writePlatform(store, PLATFORM);
    writeToken(dir, PLATFORM.id, SECRET);
    await checkPlatform(store, dir, PLATFORM.id, () =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: 'gpt-4o', kind: 'chat' }] }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    // Ровно то, что делает общий PATCH настроек: пишет список целиком, ничего
    // не зная ни про шифрохранилище, ни про следы проб.
    store.updateSettings({ platforms: [] });
    const gone = forgetOrphanPlatforms(store, dir);

    expect(gone).toEqual([PLATFORM.id]);
    expect(readToken(dir, PLATFORM.id) ?? '').toBe('');
    expect(store.getPlatformHealth()[PLATFORM.id]).toBeUndefined();
  });

  it('переименование мимо маршрута — тоже сирота: ключ лежит под старым именем', () => {
    writePlatform(store, PLATFORM);
    writeToken(dir, PLATFORM.id, SECRET);

    store.updateSettings({ platforms: [{ ...PLATFORM, id: 'enterprise-platform-prod' }] });
    forgetOrphanPlatforms(store, dir);

    expect(readToken(dir, PLATFORM.id) ?? '').toBe('');
    // Переносить ключ панель не вправе: она не знает, тот же это контур или уже
    // другой. Честный итог — контур без ключа, а не чужой ключ под новым именем.
    expect(readToken(dir, 'enterprise-platform-prod') ?? '').toBe('');
  });

  it('учёт расхода — тоже след контура и уходит вместе с ним', () => {
    writePlatform(store, PLATFORM);
    store.savePlatformSpend({
      platformId: PLATFORM.id,
      days: [],
      exhaustedAt: '2026-09-10T10:00:00.000Z',
    });

    // Идентификатор человек вправе завести заново (переименование выглядит
    // именно так) — оставленная запись приписала бы новому контуру чужой расход
    // и чужой упёртый бюджет.
    store.updateSettings({ platforms: [] });
    expect(forgetOrphanPlatforms(store, dir)).toEqual([PLATFORM.id]);
    expect(store.getPlatformSpend()[PLATFORM.id]).toBeUndefined();
  });

  /**
   * §8 №21: два контура, настроенные одновременно. Модель данных — список, и
   * это не «на будущее»: у каждого свой ключ под своим пространством имён и
   * свой след пробы, поэтому второй контур не отбирает доступ у первого.
   */
  it('два контура живут рядом: свой ключ и свой след у каждого', () => {
    const second = { ...PLATFORM, id: 'вторая', title: 'Второй контур' };
    writePlatform(store, PLATFORM);
    writePlatform(store, second);
    writeToken(dir, PLATFORM.id, SECRET);
    writeToken(dir, second.id, 'CONTOUR-KEY-SECOND-7c30');

    expect(readPlatforms(store).map((item) => item.id)).toEqual([PLATFORM.id, second.id]);
    expect(readToken(dir, PLATFORM.id)).toBe(SECRET);
    expect(readToken(dir, second.id)).toBe('CONTOUR-KEY-SECOND-7c30');
    // Уборка сирот при двух живых не уносит ни одного.
    expect(forgetOrphanPlatforms(store, dir)).toEqual([]);
  });

  it('живые контуры уборка не трогает — и чужие секреты тоже', () => {
    writePlatform(store, PLATFORM);
    writeToken(dir, PLATFORM.id, SECRET);
    setStoredKey(dir, 'anthropic', 'sk-ЧУЖОЙ-ключ-провайдера');

    expect(forgetOrphanPlatforms(store, dir)).toEqual([]);
    expect(readToken(dir, PLATFORM.id)).toBe(SECRET);
    expect(getStoredKey(dir, 'anthropic')).toBe('sk-ЧУЖОЙ-ключ-провайдера');
  });
});

describe('domains/platform/check: проба запоминается, но ничего не стирает', () => {
  const okFetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ data: [{ id: 'gpt-4o', kind: 'chat' }] }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

  it('удачная проба записывает подтверждённые возможности в сам контур', async () => {
    writePlatform(store, PLATFORM);
    await checkPlatform(store, dir, PLATFORM.id, okFetch);

    const saved = requirePlatform(store, PLATFORM.id);
    expect(saved.capabilities).toContain('models');
    expect(saved.capabilities).toContain('knowledge');
    // «Не объявлено» подтверждением не считается.
    expect(saved.capabilities).not.toContain('agents');
  });

  it('неудачная проба НЕ стирает подтверждённое раньше', async () => {
    writePlatform(store, PLATFORM);
    await checkPlatform(store, dir, PLATFORM.id, okFetch);
    const before = requirePlatform(store, PLATFORM.id).capabilities;

    await checkPlatform(store, dir, PLATFORM.id, () => Promise.reject(new Error('ECONNREFUSED')));

    expect(requirePlatform(store, PLATFORM.id).capabilities).toEqual(before);
    expect(store.getPlatformHealth()[PLATFORM.id]!.outcome).toBe('unreachable');
  });

  it('дата последнего успеха переживает неудачную пробу', async () => {
    writePlatform(store, PLATFORM);
    await checkPlatform(store, dir, PLATFORM.id, okFetch);
    const okAt = store.getPlatformHealth()[PLATFORM.id]!.lastOkAt;
    expect(okAt).toBeTruthy();

    await checkPlatform(store, dir, PLATFORM.id, () => Promise.reject(new Error('ECONNREFUSED')));

    const health = store.getPlatformHealth()[PLATFORM.id]!;
    // «Не отвечает сейчас» и «не отвечал никогда» — разные беды: первая обычно
    // про сеть, вторая про настройку, и карточка обязана их различать.
    expect(health.outcome).toBe('unreachable');
    expect(health.lastOkAt).toBe(okAt);
  });

  it('успешной пробы не было ни разу — даты нет, а не «когда-то давно»', async () => {
    writePlatform(store, PLATFORM);
    await checkPlatform(store, dir, PLATFORM.id, () => Promise.reject(new Error('ECONNREFUSED')));
    expect(store.getPlatformHealth()[PLATFORM.id]!.lastOkAt).toBeUndefined();
  });

  it('выключенный контур проверяется по кнопке: мастер проверяет ДО включения', async () => {
    writePlatform(store, { ...PLATFORM, enabled: false });
    const result = await checkPlatform(store, dir, PLATFORM.id, okFetch);
    expect(result.outcome).toBe('ok');
  });
});

describe('инвариант 1: ключ контура не покидает панель', () => {
  it('ключа нет ни в одном ответе и ни в одном файле открытым текстом', async () => {
    writePlatform(store, PLATFORM);
    writeToken(dir, PLATFORM.id, SECRET);
    await checkPlatform(store, dir, PLATFORM.id, () =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: 'gpt-4o', kind: 'chat' }] }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const answers = JSON.stringify({
      list: describePlatforms(store, dir),
      health: store.getPlatformHealth(),
      settings: store.getSettings(),
    });
    expect(answers).not.toContain(SECRET);

    const onDisk = everythingOnDisk(dir);
    expect(onDisk).not.toContain(SECRET);
    // Ключ на диске есть — но только в шифрохранилище, и найти его подстрокой
    // нельзя. Проверка выше именно об этом, а не о том, что ключа нет вовсе.
    expect(readToken(dir, PLATFORM.id)).toBe(SECRET);
  });
});
