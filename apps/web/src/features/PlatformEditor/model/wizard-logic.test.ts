import { describe, it, expect } from 'vitest';
import type { Platform, PlatformProbeResult, PlatformStatus } from '@agentdeck/contracts';
import {
  WIZARD_STEPS,
  budgetFromText,
  confirmedCapabilities,
  draftWithPatch,
  initialTargets,
  needsGatewayEnable,
  savePayload,
  stepAfter,
  stepBefore,
  toggled,
} from './wizard-logic';

/**
 * Решения мастера подключения.
 *
 * Три из них человек не увидит, пока они не сработают неправильно: имя, тянущее
 * за собой идентификатор ровно до первой правки руками; пустое поле ключа,
 * которое обязано означать «не трогали», а не «сотри»; и «не объявлено»,
 * которое не имеет права попасть в подтверждённые возможности.
 */

const DRAFT: Platform = {
  id: 'enterprise-platform-dev',
  title: 'EnterprisePlatform · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: false,
  mode: 'best-effort',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  projectPaths: [],
  consumers: [],
  agents: [],
  budgetSince: '',
  toolShim: true,
  contourPrompt: true,
  caCertPath: '',
};

const probe = (overrides: Partial<PlatformProbeResult> = {}): PlatformProbeResult => ({
  outcome: 'ok',
  reachable: true,
  url: 'https://api.dev.example.ru/v1/models',
  detail: '',
  models: [{ id: 'gpt-4o' }],
  capabilities: [],
  limits: {},
  notes: [],
  compromises: [],
  checkedAt: '2026-09-10T00:00:00.000Z',
  ...overrides,
});

describe('шаги', () => {
  it('идут по порядку в обе стороны', () => {
    expect(WIZARD_STEPS).toEqual(['address', 'token', 'capabilities', 'targets']);
    expect(stepAfter('address')).toBe('token');
    expect(stepBefore('capabilities')).toBe('token');
  });

  it('на краях стоят на месте', () => {
    // «Далее» на последнем шаге — это «Готово», а не пятый шаг; «Назад» с
    // первого закрывается отменой, и уходить в пустоту тут нечему.
    expect(stepAfter('targets')).toBe('targets');
    expect(stepBefore('address')).toBe('address');
  });
});

describe('черновик', () => {
  it('идентификатор идёт из имени, пока его не трогали', () => {
    const next = draftWithPatch(DRAFT, { title: 'EnterprisePlatform · prod' }, false);
    expect(next.id).toBe('enterprise-platform-prod');
  });

  it('тронутый идентификатор имя за собой больше не тянет', () => {
    // Ключ лежит под идентификатором: увести его правкой названия значило бы
    // молча оставить контур без ключа.
    const next = draftWithPatch({ ...DRAFT, id: 'своё-имя' }, { title: 'EnterprisePlatform · prod' }, true);
    expect(next.id).toBe('своё-имя');
  });

  it('правка другого поля идентификатор не пересчитывает', () => {
    const next = draftWithPatch(DRAFT, { budgetUsd: 100 }, false);
    expect(next.id).toBe(DRAFT.id);
    expect(next.budgetUsd).toBe(100);
  });
});

describe('подтверждённые возможности', () => {
  it('«есть» и «косвенно» считаются, «нет» и «не объявлено» — нет', () => {
    const result = probe({
      capabilities: [
        { id: 'models', state: 'yes', detail: 'список ключа', evidence: 'answer' },
        { id: 'knowledge', state: 'indirect', detail: 'через владельца', evidence: 'platform' },
        { id: 'client-tools', state: 'no', detail: 'не принимает', evidence: 'platform' },
        { id: 'agents', state: 'unknown', detail: 'не объявлено', evidence: 'platform' },
      ],
    });
    expect(confirmedCapabilities(result)).toEqual(['models', 'knowledge']);
  });

  it('неудачная проба не подтверждает ничего', () => {
    const result = probe({
      outcome: 'unreachable',
      reachable: false,
      capabilities: [{ id: 'models', state: 'yes', detail: '', evidence: 'answer' }],
    });
    expect(confirmedCapabilities(result)).toEqual([]);
  });
});

describe('с чего начинается выбор целей', () => {
  it('у нового контура файловых целей нет вовсе', () => {
    // До Т3 сюда подставлялся ассистент — единственный потребитель, работавший
    // через контур целиком. Теперь ассистент это ПОТРЕБИТЕЛЬ, а не файловая
    // цель, и подставлять его в список файлов значило бы писать в чужой
    // глобальный конфиг за человека.
    expect(initialTargets(undefined)).toEqual([]);
  });

  it('у существующего — его собственный выбор', () => {
    const existing = {
      platform: { ...DRAFT, targets: ['claude', 'codex'] },
    } as unknown as PlatformStatus;
    expect(initialTargets(existing)).toEqual(['claude', 'codex']);
  });

  it('пустой выбор существующего остаётся пустым', () => {
    // «Ни одного файла CLI» — законное состояние контура (Т3): он может возить
    // чат и не трогать ни одного конфига. Подстановка вернула бы человеку то,
    // что он снял.
    const existing = { platform: { ...DRAFT, targets: [] } } as unknown as PlatformStatus;
    expect(initialTargets(existing)).toEqual([]);
  });
});

describe('шлюз перед подъёмом', () => {
  it('выключенный включаем', () => {
    expect(needsGatewayEnable({ enabled: false, port: 5179, forceStream: true })).toBe(true);
  });

  it('включённый не трогаем: лишняя запись настроек — лишний перезапуск слушателя', () => {
    expect(needsGatewayEnable({ enabled: true, port: 5179, forceStream: true })).toBe(false);
    expect(needsGatewayEnable(undefined)).toBe(false);
  });
});

describe('список выбора', () => {
  it('щелчок отмечает и снимает', () => {
    expect(toggled([], 'claude')).toEqual(['claude']);
    expect(toggled(['assistant', 'claude'], 'claude')).toEqual(['assistant']);
  });

  it('исходный список не меняется на месте', () => {
    const current = ['assistant'];
    toggled(current, 'claude');
    expect(current).toEqual(['assistant']);
  });
});

describe('что уедет на сервер', () => {
  it('пустое поле ключа означает «не трогали»: поля в теле нет вовсе', () => {
    const payload = savePayload(DRAFT, '');
    expect(payload).not.toHaveProperty('token');
    expect(payload.platform.id).toBe(DRAFT.id);
  });

  it('введённый ключ уезжает как есть', () => {
    expect(savePayload(DRAFT, 'sk-новый-ключ').token).toBe('sk-новый-ключ');
  });

  it('пробелы вокруг адреса срезаются до записи', () => {
    // Адрес человек вставляет из админки вместе с переводом строки, а сравнение
    // «место занято» идёт строкой: незамеченный пробел поднял бы ложный конфликт.
    const payload = savePayload({ ...DRAFT, baseUrl: '  https://api.dev.example.ru \n' }, '');
    expect(payload.platform.baseUrl).toBe('https://api.dev.example.ru');
  });
});

describe('бюджет из набранного текста', () => {
  // Найдено враждебным ревью Т8: поле управляемое, и число в черновике стирало
  // незаконченный ввод — «10.» превращалось в «10», а следующая цифра давала
  // 105, то есть десятикратный бюджет.
  it('незаконченная дробь не превращается в целое', () => {
    expect(budgetFromText('10.').usd).toBe(10);
    expect(budgetFromText('10.5').usd).toBe(10.5);
    expect(budgetFromText('0.5').usd).toBe(0.5);
  });

  it('запятая — это точка: цифру набирают как привыкли', () => {
    expect(budgetFromText('10,5').usd).toBe(10.5);
  });

  it('пусто значит «не следить», и это не ошибка', () => {
    expect(budgetFromText('')).toEqual({ usd: 0, broken: false });
    expect(budgetFromText('   ')).toEqual({ usd: 0, broken: false });
  });

  it('непонятный ввод назван ошибкой, а не подставлен догадкой', () => {
    expect(budgetFromText('сто')).toEqual({ usd: 0, broken: true });
    expect(budgetFromText('-5')).toEqual({ usd: 0, broken: true });
  });
});
