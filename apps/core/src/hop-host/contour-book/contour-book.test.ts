import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlatformGatewayEvent } from '@agentdeck/contracts';
import {
  BUDGET_NOTICES_KEPT,
  CONTOUR_EVENTS_KEPT,
  CONTOUR_SPEND_FILE,
  ContourBook,
} from './contour-book.ts';
import { panelContours } from './panel-state.ts';

/**
 * Учёт контуров звена (C3b) — на настоящем чтении файлов панели (`panelContours` над временным
 * `state.json`) и настоящем файле учёта: подменять нечего, оба — файловая система.
 * Здесь живут правила, которые до C3b проверяли тесты панели (`spend-flush`, `usage`,
 * `store.forgetPlatformSpend`, конвейер Т8): теперь их исполняет книга звена.
 */

const MODEL = 'Qwen/Qwen3.8-27B-FP8';
const AT = new Date('2026-11-02T10:00:00');

let root: string;
let panelDir: string;
let file: string;

interface PlatformSeed {
  id: string;
  title?: string;
  budgetUsd?: number;
  budgetSince?: string;
}

function writeState(platforms: PlatformSeed[], extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(panelDir, 'state.json'),
    JSON.stringify({
      settings: {
        platforms,
        // Цена человека фрагментом имени — то, чем панель оценивала модели компании (контур №7).
        modelPricing: { 'qwen3.8': { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 } },
      },
      ...extra,
    }),
  );
}

const book = (): ContourBook => new ContourBook(file, panelContours(panelDir), AT.getTime());

const usage = (totalTokens: number, extra: Record<string, unknown> = {}) => ({
  model: MODEL,
  promptTokens: totalTokens,
  completionTokens: 0,
  totalTokens,
  ...extra,
});

const event = (status: number, at = AT): PlatformGatewayEvent =>
  ({
    at: at.toISOString(),
    platformId: 'dev',
    path: '/dev/v1/messages',
    status,
  }) as PlatformGatewayEvent;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-contour-book-'));
  panelDir = join(root, 'panel');
  file = join(root, CONTOUR_SPEND_FILE);
  mkdirSync(panelDir, { recursive: true });
  writeState([{ id: 'dev', title: 'Company · dev' }]);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('книга контуров: дни расхода', () => {
  it('расход ложится днём по цене человека и переживает перезапуск звена', () => {
    const first = book();
    first.usage('dev', usage(1_000_000, { completionTokens: 0 }), AT);
    const day = first.records().dev!.days[0]!;
    expect(day).toMatchObject({ requests: 1, totalTokens: 1_000_000 });
    // 1 млн входа по 1 $ за миллион — цена из `settings.modelPricing` панели.
    expect(day.money.usd).toBeCloseTo(1, 9);
    expect(day.money.unpricedModels).toEqual([]);

    // Новый процесс звена читает тот же файл: день на месте.
    expect(book().records().dev!.days[0]!.totalTokens).toBe(1_000_000);
  });

  it('пустой ответ живой счётчик считает, а дня не заводит; «без счёта» — заводит счётчиком', () => {
    const ledger = book();
    ledger.usage('dev', usage(0), AT);
    expect(ledger.records().dev).toBeUndefined();
    expect(ledger.snapshot().usage).toEqual([
      expect.objectContaining({ platformId: 'dev', requests: 1 }),
    ]);

    ledger.usage('dev', usage(0, { unreported: true }), AT);
    const day = ledger.records().dev!.days[0]!;
    expect(day.unreportedAnswers).toBe(1);
    expect(day.totalTokens).toBe(0);
  });

  it('контура нет в панели — расход не воскрешает его, удалённый уносит свои дни', () => {
    const ledger = book();
    ledger.usage('ghost', usage(500), AT);
    expect(ledger.records().ghost).toBeUndefined();

    ledger.usage('dev', usage(500), AT);
    expect(ledger.records().dev).toBeDefined();
    // Человек удалил контур: id могут завести заново — новый не должен начать с чужих дней.
    writeState([]);
    // mtime файла панели может совпасть в пределах тика — перечитывание по времени записи.
    bumpMtime();
    expect(ledger.records().dev).toBeUndefined();
    expect(JSON.parse(readFileSync(file, 'utf8')).records).toEqual({});
  });
});

describe('книга контуров: отказ по бюджету (402)', () => {
  it('новый отказ заменяет прежний целиком, а не наследует его уровень; снять может только человек', () => {
    const ledger = book();
    ledger.exhausted('dev', AT, { scope: 'limit', level: 'team_monthly' });
    expect(ledger.records().dev).toMatchObject({
      exhaustedScope: 'limit',
      exhaustedLevel: 'team_monthly',
    });

    ledger.exhausted('dev', new Date(AT.getTime() + 1000), { scope: 'key' });
    const record = ledger.records().dev!;
    expect(record.exhaustedScope).toBe('key');
    expect(record).not.toHaveProperty('exhaustedLevel');

    // Отказ без названия — полей нет вовсе: придумывать, что кончилось, нельзя.
    ledger.exhausted('dev', AT);
    expect(ledger.records().dev).not.toHaveProperty('exhaustedScope');

    // Факт пишется сразу и переживает перезапуск.
    expect(book().records().dev!.exhaustedAt).toBeTruthy();
    expect(ledger.clearExhausted('dev')).toBe(true);
    expect(ledger.records().dev).not.toHaveProperty('exhaustedAt');
    expect(ledger.clearExhausted('dev')).toBe(false);
  });

  it('отказ контура, которого нет в панели, не пишется', () => {
    const ledger = book();
    ledger.exhausted('ghost', AT);
    expect(ledger.records().ghost).toBeUndefined();
  });
});

describe('книга контуров: пороги бюджета', () => {
  beforeEach(() => writeState([{ id: 'dev', title: 'Company · dev', budgetUsd: 10 }]));

  it('порог внимания и бюджет звучат по разу, отметка переживает перезапуск, ручной сброс снимает её', () => {
    const ledger = book();
    ledger.usage('dev', usage(8_000_000), AT);
    ledger.flush();
    expect(ledger.snapshot().notices).toEqual([]);

    ledger.usage('dev', usage(1_000_000), AT); // 9 $ из 10 — 90 %
    ledger.flush();
    expect(ledger.snapshot().notices).toEqual([
      expect.objectContaining({
        seq: 1,
        platformId: 'dev',
        platformTitle: 'Company · dev',
        level: 'near',
      }),
    ]);
    expect(ledger.snapshot().notices[0]!.share).toBeCloseTo(0.9, 6);

    // Цифра гуляет у границы — второй раз о том же не говорим.
    ledger.usage('dev', usage(100_000), AT);
    ledger.flush();
    expect(ledger.snapshot().notices).toHaveLength(1);

    // Перезапуск звена: сказанное помнится, `seq` продолжает расти.
    const again = book();
    again.usage('dev', usage(2_000_000), AT); // 11.1 $ — бюджет перейдён
    again.flush();
    expect(again.snapshot().notices.map((item) => [item.seq, item.level])).toEqual([
      [1, 'near'],
      [2, 'over'],
    ]);

    // Человек продлил бюджет и снял отметку: следующий переход обязан прозвучать.
    again.exhausted('dev', AT);
    expect(again.clearExhausted('dev')).toBe(true);
    expect(again.records().dev).not.toHaveProperty('announcedBudget');
    again.usage('dev', usage(1), AT);
    again.flush();
    expect(again.snapshot().notices.at(-1)).toMatchObject({ seq: 3, level: 'over' });
  });

  it('бюджет не задан — порогов нет; кольцо извещений ограничено', () => {
    writeState([{ id: 'dev' }]);
    bumpMtime();
    const ledger = book();
    ledger.usage('dev', usage(50_000_000), AT);
    ledger.flush();
    expect(ledger.snapshot().notices).toEqual([]);
    expect(BUDGET_NOTICES_KEPT).toBe(50);
  });
});

describe('книга контуров: перенос учёта панели (первый запуск)', () => {
  const legacyDay = {
    day: '2026-10-01',
    requests: 4,
    promptTokens: 100,
    completionTokens: 40,
    totalTokens: 140,
    money: { usd: 0.7, pricedTokens: 140, unpricedTokens: 0, unpricedModels: [] },
  };

  it('файла учёта нет — дни панели живых контуров переезжают один раз; файл есть — нет', () => {
    writeState([{ id: 'dev' }], {
      platformSpend: {
        dev: { platformId: 'dev', days: [legacyDay], exhaustedAt: '2026-10-02T00:00:00.000Z' },
        gone: { platformId: 'gone', days: [legacyDay] },
      },
    });
    const ledger = book();
    expect(ledger.records()).toEqual({
      dev: { platformId: 'dev', days: [legacyDay], exhaustedAt: '2026-10-02T00:00:00.000Z' },
    });
    expect(existsSync(file)).toBe(true);

    // Файл учёта уже есть: застывший след панели второй раз не переносится (иначе стёр бы новое).
    ledger.clearExhausted('dev');
    expect(book().records().dev).not.toHaveProperty('exhaustedAt');
  });
});

describe('книга контуров: след запросов', () => {
  it('новые сверху, не больше 50, отказы считаются', () => {
    const ledger = book();
    for (let i = 0; i < CONTOUR_EVENTS_KEPT + 5; i += 1)
      ledger.event(event(i % 10 === 0 ? 502 : 200));
    const snap = ledger.snapshot();
    expect(snap.events).toHaveLength(CONTOUR_EVENTS_KEPT);
    expect(snap.requests).toBe(CONTOUR_EVENTS_KEPT + 5);
    expect(snap.failures).toBe(6);
  });
});

/** Сдвинуть время записи `state.json`: кэш панели перечитывает файл по mtime. */
function bumpMtime(): void {
  const path = join(panelDir, 'state.json');
  const text = readFileSync(path, 'utf8');
  const later = new Date(Date.now() + 5_000);
  writeFileSync(path, text);
  utimesSync(path, later, later);
}
