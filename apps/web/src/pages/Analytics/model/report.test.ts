import { describe, it, expect } from 'vitest';
import type {
  Analytics,
  DailyUsage,
  ModelUsage,
  ProjectUsage,
  SessionUsage,
  TokenTotals,
} from '@claude-control/contracts';
import {
  buildDailyCsv,
  buildModelsCsv,
  buildProjectsCsv,
  buildSessionsCsv,
  buildReportCsv,
  buildJson,
  csvCell,
  DAILY_CSV_HEADER,
  MODEL_CSV_HEADER,
  PROJECT_CSV_HEADER,
  SESSION_CSV_HEADER,
} from './report';

/**
 * Выгрузка аналитики в CSV/JSON. Ставка теста: файл уходит в чужие руки (Excel,
 * Sheets), поэтому проверяем не «примерно», а что колонки СХОДЯТСЯ с total, что
 * стоимость и разрезы по моделям/проектам/сессиям в файл попадают и что опасное
 * содержимое ячейки не исполнится как формула.
 */

function totals(partial: Partial<TokenTotals>): TokenTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    total: 0,
    requests: 0,
    ...partial,
  };
}

function day(date: string, t: Partial<TokenTotals>, estimatedCost = 0): DailyUsage {
  return { date, totals: totals(t), estimatedCost };
}

describe('buildDailyCsv', () => {
  it('заголовок содержит cacheCreation — иначе total не сходится со столбцами', () => {
    expect(DAILY_CSV_HEADER).toContain('cacheCreation');
  });

  it('заголовок содержит estimatedCost — по дням стоимость доступна и нужна в отчёте', () => {
    expect(DAILY_CSV_HEADER).toContain('estimatedCost');
  });

  it('пустые данные → только заголовок, файл валиден', () => {
    const csv = buildDailyCsv([]);
    expect(csv).toBe(DAILY_CSV_HEADER.join(','));
    expect(csv.split('\r\n')).toHaveLength(1);
  });

  it('строка дня раскладывается по колонкам в объявленном порядке', () => {
    const csv = buildDailyCsv([
      day(
        '2026-07-18',
        {
          input: 100,
          output: 50,
          cacheRead: 10,
          cacheCreation: 40,
          total: 200,
          requests: 3,
        },
        1.25,
      ),
    ]);
    const [, row] = csv.split('\r\n');
    // date,total,input,output,cacheRead,cacheCreation,requests,estimatedCost
    expect(row).toBe('2026-07-18,200,100,50,10,40,3,1.25');
  });

  it('сумма показанных токен-столбцов равна total (cacheCreation учтён)', () => {
    const csv = buildDailyCsv([
      day('2026-07-18', {
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheCreation: 40,
        total: 200,
        requests: 1,
      }),
    ]);
    const cols = csv.split('\r\n')[1]!.split(',').map(Number);
    // total,input,output,cacheRead,cacheCreation после колонки date
    const [, total, input, output, cacheRead, cacheCreation] = cols;
    expect(input! + output! + cacheRead! + cacheCreation!).toBe(total);
  });

  it('несколько дней — по строке на каждый', () => {
    const csv = buildDailyCsv([
      day('2026-07-18', { total: 1, requests: 1 }),
      day('2026-07-19', { total: 2, requests: 1 }),
    ]);
    expect(csv.split('\r\n')).toHaveLength(3); // заголовок + 2 строки
  });
});

describe('buildModelsCsv', () => {
  const model = (name: string, t: Partial<TokenTotals>, estimatedCost: number): ModelUsage => ({
    model: name,
    totals: totals(t),
    estimatedCost,
  });

  it('заголовок содержит колонку стоимости', () => {
    expect(MODEL_CSV_HEADER).toContain('estimatedCost');
  });

  it('строка модели раскладывается по колонкам, стоимость на месте', () => {
    const csv = buildModelsCsv([
      model('claude-opus-4-8', { input: 10, output: 5, total: 20, requests: 2 }, 3.5),
    ]);
    const [, row] = csv.split('\r\n');
    // model,total,input,output,cacheRead,cacheCreation,requests,estimatedCost
    expect(row).toBe('claude-opus-4-8,20,10,5,0,0,2,3.5');
  });

  it('пустой список → только заголовок', () => {
    expect(buildModelsCsv([])).toBe(MODEL_CSV_HEADER.join(','));
  });
});

describe('buildProjectsCsv', () => {
  const project = (name: string, estimatedCost: number): ProjectUsage => ({
    project: name,
    displayName: 'Проект',
    totals: totals({ total: 100, input: 60, output: 40, requests: 4 }),
    estimatedCost,
    sessions: 2,
    lastActivity: '2026-07-18T10:00:00.000Z',
  });

  it('заголовок содержит стоимость, число сессий и последнюю активность', () => {
    expect(PROJECT_CSV_HEADER).toContain('estimatedCost');
    expect(PROJECT_CSV_HEADER).toContain('sessions');
    expect(PROJECT_CSV_HEADER).toContain('lastActivity');
  });

  it('строка проекта включает стоимость и метаданные', () => {
    const csv = buildProjectsCsv([project('C:/work/proj', 7.75)]);
    const [, row] = csv.split('\r\n');
    expect(row).toBe('C:/work/proj,Проект,100,60,40,0,0,4,7.75,2,2026-07-18T10:00:00.000Z');
  });
});

describe('buildSessionsCsv', () => {
  const session = (id: string): SessionUsage => ({
    sessionId: id,
    project: 'C:/work/proj',
    displayName: 'Проект',
    startedAt: '2026-07-18T09:00:00.000Z',
    lastActivity: '2026-07-18T10:00:00.000Z',
    totals: totals({ total: 50, input: 30, output: 20, requests: 2 }),
    estimatedCost: 1.5,
    models: ['claude-opus-4-8', 'claude-sonnet-4-5'],
    isActive: true,
  });

  it('заголовок содержит недавние сессии со стоимостью', () => {
    expect(SESSION_CSV_HEADER).toContain('estimatedCost');
    expect(SESSION_CSV_HEADER).toContain('sessionId');
  });

  it('несколько моделей склеиваются в одну ячейку без разъезда столбцов', () => {
    const csv = buildSessionsCsv([session('s1')]);
    const rows = csv.split('\r\n');
    expect(rows).toHaveLength(2);
    // Модели через "; " внутри одной ячейки — запятой в них нет, столбцы целы.
    expect(rows[1]).toContain('claude-opus-4-8; claude-sonnet-4-5');
    expect(rows[1]!.startsWith('s1,C:/work/proj,Проект,')).toBe(true);
    expect(rows[1]!.endsWith(',1.5,claude-opus-4-8; claude-sonnet-4-5,true')).toBe(true);
  });
});

function analytics(partial: Partial<Analytics> = {}): Analytics {
  return {
    from: '2026-07-01',
    to: '2026-07-18',
    overall: totals({ total: 100, requests: 5 }),
    estimatedCost: 5,
    byModel: [{ model: 'claude-opus-4-8', totals: totals({ total: 100 }), estimatedCost: 5 }],
    byDay: [day('2026-07-18', { total: 100, requests: 5 }, 5)],
    byProject: [
      {
        project: 'C:/work/proj',
        displayName: 'Проект',
        totals: totals({ total: 100 }),
        estimatedCost: 5,
        sessions: 1,
        lastActivity: '2026-07-18T10:00:00.000Z',
      },
    ],
    byHour: [],
    recentSessions: [
      {
        sessionId: 's1',
        project: 'C:/work/proj',
        displayName: 'Проект',
        startedAt: '2026-07-18T09:00:00.000Z',
        lastActivity: '2026-07-18T10:00:00.000Z',
        totals: totals({ total: 100 }),
        estimatedCost: 5,
        models: ['claude-opus-4-8'],
        isActive: false,
      },
    ],
    topTools: [],
    topSkills: [],
    runningAgents: [{ pid: 4242, name: 'claude.exe', memoryMb: 512 }],
    activeSessions: 0,
    scannedFiles: 1,
    scanDurationMs: 10,
    cacheHitRatio: 0,
    ...partial,
  };
}

describe('buildReportCsv', () => {
  it('содержит все разрезы: дни, модели, проекты, сессии', () => {
    const csv = buildReportCsv(analytics());
    expect(csv).toContain('По дням');
    expect(csv).toContain('По моделям');
    expect(csv).toContain('По проектам');
    expect(csv).toContain('Недавние сессии');
    // Заголовки таблиц каждой секции на месте.
    expect(csv).toContain(MODEL_CSV_HEADER.join(','));
    expect(csv).toContain(PROJECT_CSV_HEADER.join(','));
    expect(csv).toContain(SESSION_CSV_HEADER.join(','));
  });
});

describe('buildJson — приватность выгрузки', () => {
  it('не тащит runningAgents (живые процессы машины)', () => {
    const json = buildJson(analytics());
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('runningAgents');
    // Исторический расход при этом на месте.
    expect(parsed).toHaveProperty('byModel');
    expect(parsed).toHaveProperty('byDay');
  });

  it('не мутирует исходный объект (delete идёт по копии)', () => {
    const data = analytics();
    buildJson(data);
    expect(data.runningAgents).toHaveLength(1);
  });
});

describe('csvCell — экранирование и защита от инъекции формул', () => {
  it('обычный текст и числа отдаются как есть', () => {
    expect(csvCell('2026-07-18')).toBe('2026-07-18');
    expect(csvCell(42)).toBe('42');
  });

  it('булево значение отдаётся как текст', () => {
    expect(csvCell(true)).toBe('true');
    expect(csvCell(false)).toBe('false');
  });

  it('запятая внутри значения оборачивается в кавычки', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
  });

  it('кавычки внутри значения удваиваются', () => {
    expect(csvCell('a"b')).toBe('"a""b"');
  });

  it('перенос строки внутри значения оборачивается в кавычки', () => {
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });

  it('формула с ведущим "=" гасится апострофом и не исполнится', () => {
    // Классическая инъекция: =HYPERLINK / =cmd|... . Ведущий апостроф → текст.
    expect(csvCell('=1+2')).toBe("'=1+2");
  });

  it('ведущие + - @ тоже гасятся', () => {
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1+1')).toBe("'-1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('опасный префикс вместе с запятой: и погашен, и обёрнут', () => {
    expect(csvCell('=1,2')).toBe('"\'=1,2"');
  });
});
