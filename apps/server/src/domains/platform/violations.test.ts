import { describe, it, expect } from 'vitest';
import type { PlatformGatewayEvent } from '@agentdeck/contracts';
import { violationReport } from './violations.ts';
import { enterprise-platformDriver } from './drivers/enterprise-platform.ts';
import { bridgeUpstreamStatus } from './gateway/status.ts';

/**
 * Сводка проверок контура: что именно человек увидит в карточке.
 *
 * Проверяется не форма, а различимость исходов: «запрос не приняли», «ответ
 * оборвали» и «данные замаскировали» чинятся в разных местах, и слитые в одну
 * строку они одинаково бесполезны. Плюс главное свойство всей задачи — в сводку
 * не может попасть текст, на котором сработала проверка.
 */

const event = (patch: Partial<PlatformGatewayEvent>): PlatformGatewayEvent => ({
  at: '2026-09-10T10:00:00.000Z',
  platformId: 'enterprise-platform',
  path: '/enterprise-platform/v1/chat/completions',
  dialect: 'openai-compat',
  status: 200,
  stages: [],
  summarized: false,
  violations: [],
  masked: false,
  blocked: false,
  interrupted: false,
  unknownFrames: [],
  lost: [],
  shimmed: [],
  toolCalls: 0,
  contourCalls: 0,
  toolFlaws: [],
  claimedWithoutCall: false,
  totalTokens: 0,
  ...patch,
});

describe('violationReport: три исхода различимы', () => {
  it('451 — запрос не приняли: модель его не видела', () => {
    const report = violationReport([
      event({
        status: 400,
        blocked: true,
        violations: ['pii'],
        error: 'Проверки контента контура остановили',
      }),
    ]);

    expect(report.rows).toEqual([
      {
        name: 'pii',
        count: 1,
        lastAt: '2026-09-10T10:00:00.000Z',
        actions: ['blocked'],
        platformIds: ['enterprise-platform'],
      },
    ]);
    expect(report.total).toBe(1);
  });

  it('обрыв в потоке — не «не приняли»: часть ответа человек уже прочитал', () => {
    const report = violationReport([
      event({ status: 400, blocked: true, violations: ['toxicity'], interrupted: true }),
    ]);

    expect(report.rows[0]?.actions).toEqual(['interrupted']);
  });

  it('маскировка — ответ пришёл, но модель видела не то', () => {
    const report = violationReport([event({ status: 200, violations: ['secrets'], masked: true })]);

    expect(report.rows[0]?.actions).toEqual(['masked']);
  });

  it('маскировка без названий не теряется: считается отдельно', () => {
    // Названия — необязательная часть кадра. Без этого счётчика ответ, в котором
    // контур что-то заменил, выглядел бы как ответ, в котором ничего не было.
    const report = violationReport([event({ status: 200, masked: true })]);

    expect(report.rows).toEqual([]);
    expect(report.maskedUnnamed).toBe(1);
  });

  it('маскировка и обрыв в одном запросе — оба исхода, а не первый попавшийся', () => {
    const report = violationReport([
      event({ status: 400, blocked: true, violations: ['pii'], masked: true, interrupted: true }),
    ]);

    expect(report.rows[0]?.actions).toEqual(['masked', 'interrupted']);
  });
});

describe('безымянное срабатывание не теряется', () => {
  it('отказ без единого названия — не «проверки молчали»', () => {
    // Просеиватель имён строг намеренно: в теле 451 рядом с категорией лежит
    // текст, на котором сработали. Ответ, названий не приславший или
    // приславший их в незнакомом виде, — обычное дело, и раньше такой запрос
    // исчезал из сводки целиком: карточка писала «проверки ни разу не
    // срабатывали» человеку, чей запрос контур не принял.
    const report = violationReport([event({ status: 400, blocked: true })]);

    expect(report.rows).toEqual([]);
    expect(report.blockedUnnamed).toBe(1);
    expect(report.interruptedUnnamed).toBe(0);
  });

  it('обрыв без названий считается своим счётом', () => {
    // Кадр `{"enterprise-platform_guardrails":{"stream_interrupted":true}}` — ровно тот,
    // что описан в справочнике: ни одного имени в нём нет.
    const report = violationReport([event({ status: 400, interrupted: true })]);

    expect(report.interruptedUnnamed).toBe(1);
    expect(report.blockedUnnamed).toBe(0);
  });

  it('отказ по ключу и бюджету проверкам не приписывается', () => {
    // 401, 402 и 429 доезжают до клиента теми же четырёхсотыми, что и 451.
    // Считая их отказом проверок, панель отправила бы человека чинить свой
    // запрос там, где кончился бюджет.
    const report = violationReport([
      event({ status: 401, error: 'Ключ контура отклонён' }),
      event({ status: 402, error: 'Бюджет ключа исчерпан' }),
      event({ status: 429, error: 'Лимит частоты' }),
    ]);

    expect(report.blockedUnnamed).toBe(0);
    expect(report.rows).toEqual([]);
  });
});

describe('сводка не смешивает контуры', () => {
  it('считаем только по названным контурам — выключенный уходит с экрана', () => {
    const report = violationReport(
      [
        event({ status: 400, blocked: true, violations: ['pii'] }),
        event({ platformId: 'other', status: 400, blocked: true, violations: ['toxicity'] }),
      ],
      { platformIds: ['enterprise-platform'] },
    );

    expect(report.rows.map((row) => row.name)).toEqual(['pii']);
  });

  it('одна проверка на двух контурах помнит оба', () => {
    // Строка без принадлежности читается как принадлежащая тому контуру, на
    // который человек сейчас смотрит.
    const report = violationReport([
      event({ status: 400, blocked: true, violations: ['pii'] }),
      event({ platformId: 'other', status: 400, blocked: true, violations: ['pii'] }),
    ]);

    expect(report.rows[0]?.platformIds).toEqual(['enterprise-platform', 'other']);
  });
});

describe('violationReport: счёт и порядок', () => {
  it('одна проверка складывается по всем запросам, дата берётся последняя', () => {
    const report = violationReport([
      event({ at: '2026-09-10T12:00:00.000Z', status: 400, blocked: true, violations: ['pii'] }),
      event({ at: '2026-09-10T10:00:00.000Z', status: 400, blocked: true, violations: ['pii'] }),
    ]);

    expect(report.rows[0]).toMatchObject({ name: 'pii', count: 2 });
    expect(report.rows[0]?.lastAt).toBe('2026-09-10T12:00:00.000Z');
  });

  it('частые сверху, при равенстве — по алфавиту', () => {
    const report = violationReport([
      event({ status: 400, blocked: true, violations: ['toxicity'] }),
      event({ status: 400, blocked: true, violations: ['toxicity'] }),
      event({ status: 400, blocked: true, violations: ['secrets'] }),
      event({ status: 400, blocked: true, violations: ['pii'] }),
    ]);

    expect(report.rows.map((row) => row.name)).toEqual(['toxicity', 'pii', 'secrets']);
  });

  it('следов нет вовсе — не ноль, а отсутствие даты', () => {
    // «Проверки ничего не нашли» и «запросов через шлюз не было» — разные вещи,
    // и вторую нельзя показывать как первую.
    const report = violationReport([]);

    expect(report).toEqual({
      rows: [],
      total: 0,
      maskedUnnamed: 0,
      blockedUnnamed: 0,
      interruptedUnnamed: 0,
    });
    expect(report.since).toBeUndefined();
  });

  it('считаем с самого старого следа, а не «с запуска»', () => {
    // След ограничен по длине: после полусотни запросов «с момента запуска»
    // стало бы неправдой.
    const report = violationReport([
      event({ at: '2026-09-10T12:00:00.000Z' }),
      event({ at: '2026-09-10T09:00:00.000Z' }),
    ]);

    expect(report.since).toBe('2026-09-10T09:00:00.000Z');
  });
});

describe('текст проверки в сводку не попадает', () => {
  it('перечень 451 с кусками запроса доезжает до карточки одними названиями', () => {
    // Так тело 451 и выглядит: рядом с категорией лежит то, на чём сработали, —
    // фрагмент запроса, ключ, адрес внутреннего хоста. Просеивание живёт в
    // разборе ответа контура, сводка складывает уже просеянное; тест держит
    // обе половины разом, потому что порознь дыра между ними не видна.
    const bridged = bridgeUpstreamStatus(
      451,
      {
        error: {
          message: 'Запрос остановлен проверками',
          violations: [
            { category: 'pii', matched_text: 'Иванов Иван Иванович, паспорт 4509 №123456' },
            { name: 'secrets', evidence: 'AKIAIOSFODNN7EXAMPLE' },
            'db.internal.corp.ru',
            'токсичность в третьем абзаце',
          ],
        },
      },
      { driverRows: enterprise-platformDriver.statusRows },
    );

    const report = violationReport([
      event({ status: 400, blocked: true, violations: bridged.violations }),
    ]);
    const text = JSON.stringify(report);

    expect(report.rows.map((row) => row.name)).toEqual(['pii', 'secrets']);
    expect(text).not.toContain('Иванов');
    expect(text).not.toContain('4509');
    expect(text).not.toContain('AKIA');
    expect(text).not.toContain('db.internal.corp.ru');
    expect(text).not.toContain('токсичность');
  });
});
