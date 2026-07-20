import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanAnalytics } from './scanner.ts';

/**
 * Тесты сканера транскриптов — источника аналитики расхода. Читает .jsonl
 * построчно и агрегирует по моделям/дням/проектам/часам. Проверяем ключевое:
 * суммы сходятся, битые и посторонние строки не ломают разбор, старые записи
 * отсекаются по окну. Тест-кейсы см. .agent/TEST-CASES.md → «Сканер аналитики».
 *
 * Транскрипты кладём во временную папку с реальной структурой
 * projects/<проект>/<сессия>.jsonl и убираем за собой.
 */
describe('scanAnalytics', () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'cc-scan-'));
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  /** Свежая метка времени внутри окна сканирования (час назад). */
  function recentIso(offsetMs = 60 * 60 * 1000): string {
    return new Date(Date.now() - offsetMs).toISOString();
  }

  /** Пишет транскрипт проекта из готовых строк-объектов. */
  function writeTranscript(project: string, session: string, entries: unknown[]): void {
    const dir = join(projectsDir, project);
    mkdirSync(dir, { recursive: true });
    const body = entries.map((e) => JSON.stringify(e)).join('\n');
    writeFileSync(join(dir, `${session}.jsonl`), body + '\n');
  }

  function assistant(opts: {
    ts: string;
    model: string;
    cwd: string;
    sessionId: string;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
    tool?: string;
  }): unknown {
    const content = opts.tool ? [{ type: 'tool_use', name: opts.tool }] : [];
    return {
      type: 'assistant',
      timestamp: opts.ts,
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      message: {
        model: opts.model,
        usage: {
          input_tokens: opts.input ?? 0,
          output_tokens: opts.output ?? 0,
          cache_read_input_tokens: opts.cacheRead ?? 0,
          cache_creation_input_tokens: opts.cacheCreation ?? 0,
        },
        content,
      },
    };
  }

  const options = { days: 30, recentSessionsLimit: 10 };

  it('несуществующая папка проектов → пустой отчёт без падения', async () => {
    const result = await scanAnalytics(join(projectsDir, 'нет-такой'), options);
    expect(result.overall.requests).toBe(0);
    expect(result.byModel).toEqual([]);
    expect(result.scannedFiles).toBe(0);
  });

  it('суммирует токены и запросы по всем записям', async () => {
    writeTranscript('proj-a', 'sess1', [
      assistant({
        ts: recentIso(),
        model: 'claude-opus-4-8',
        cwd: '/work/a',
        sessionId: 's1',
        input: 100,
        output: 50,
      }),
      assistant({
        ts: recentIso(),
        model: 'claude-opus-4-8',
        cwd: '/work/a',
        sessionId: 's1',
        input: 200,
        output: 30,
        cacheRead: 10,
      }),
    ]);

    const result = await scanAnalytics(projectsDir, options);
    expect(result.overall.input).toBe(300);
    expect(result.overall.output).toBe(80);
    expect(result.overall.cacheRead).toBe(10);
    expect(result.overall.requests).toBe(2);
    // total = сумма всех категорий.
    expect(result.overall.total).toBe(300 + 80 + 10);
    // Расход посчитан (точные ставки проверяет pricing.test) — положительный.
    expect(result.estimatedCost).toBeGreaterThan(0);
  });

  it('группирует по моделям и сортирует по объёму токенов', async () => {
    writeTranscript('proj-a', 'sess1', [
      assistant({
        ts: recentIso(),
        model: 'claude-haiku-4-5',
        cwd: '/work/a',
        sessionId: 's1',
        input: 10,
      }),
      assistant({
        ts: recentIso(),
        model: 'claude-opus-4-8',
        cwd: '/work/a',
        sessionId: 's1',
        input: 1000,
      }),
    ]);

    const result = await scanAnalytics(projectsDir, options);
    expect(result.byModel).toHaveLength(2);
    // Крупнейшая по токенам модель — первой.
    expect(result.byModel[0]?.model).toBe('claude-opus-4-8');
  });

  /** Локальная дата `YYYY-MM-DD` момента — как её считает byDay. */
  function localDay(ts: string): string {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  it('группирует по дню (локальная дата записи)', async () => {
    const ts = recentIso();
    const day = localDay(ts);
    writeTranscript('proj-a', 'sess1', [
      assistant({ ts, model: 'claude-opus-4-8', cwd: '/work/a', sessionId: 's1', input: 100 }),
    ]);

    const result = await scanAnalytics(projectsDir, options);
    expect(result.byDay).toHaveLength(1);
    expect(result.byDay[0]?.date).toBe(day);
  });

  it('разные проекты учитываются отдельно; сессии считаются', async () => {
    writeTranscript('proj-a', 'sess1', [
      assistant({
        ts: recentIso(),
        model: 'claude-opus-4-8',
        cwd: '/work/alpha',
        sessionId: 's1',
        input: 100,
      }),
    ]);
    writeTranscript('proj-b', 'sess2', [
      assistant({
        ts: recentIso(),
        model: 'claude-opus-4-8',
        cwd: '/work/beta',
        sessionId: 's2',
        input: 100,
      }),
    ]);

    const result = await scanAnalytics(projectsDir, options);
    expect(result.byProject).toHaveLength(2);
    expect(result.byProject.every((p) => p.sessions === 1)).toBe(true);
  });

  it('считает вызовы инструментов в topTools', async () => {
    writeTranscript('proj-a', 'sess1', [
      assistant({
        ts: recentIso(),
        model: 'claude-opus-4-8',
        cwd: '/work/a',
        sessionId: 's1',
        input: 1,
        tool: 'Read',
      }),
      assistant({
        ts: recentIso(),
        model: 'claude-opus-4-8',
        cwd: '/work/a',
        sessionId: 's1',
        input: 1,
        tool: 'Read',
      }),
      assistant({
        ts: recentIso(),
        model: 'claude-opus-4-8',
        cwd: '/work/a',
        sessionId: 's1',
        input: 1,
        tool: 'Bash',
      }),
    ]);

    const result = await scanAnalytics(projectsDir, options);
    const read = result.topTools.find((t) => t.name === 'Read');
    expect(read?.count).toBe(2);
    expect(result.topTools[0]?.name).toBe('Read'); // самый частый — первым
  });

  it('битая строка пропускается, остальные считаются', async () => {
    const dir = join(projectsDir, 'proj-a');
    mkdirSync(dir, { recursive: true });
    const good = JSON.stringify(
      assistant({
        ts: recentIso(),
        model: 'claude-opus-4-8',
        cwd: '/work/a',
        sessionId: 's1',
        input: 100,
      }),
    );
    // Вторая строка — обрезанный JSON (как у активной сессии): не должна ронять разбор.
    writeFileSync(join(dir, 'sess1.jsonl'), good + '\n{"type":"assistant","message":{"usa\n');

    const result = await scanAnalytics(projectsDir, options);
    expect(result.overall.requests).toBe(1);
    expect(result.overall.input).toBe(100);
  });

  it('не-assistant записи и записи без usage игнорируются', async () => {
    writeTranscript('proj-a', 'sess1', [
      { type: 'user', timestamp: recentIso(), message: { content: 'привет' } },
      { type: 'assistant', timestamp: recentIso(), message: { model: 'claude-opus-4-8' } }, // нет usage
      assistant({
        ts: recentIso(),
        model: 'claude-opus-4-8',
        cwd: '/work/a',
        sessionId: 's1',
        input: 42,
      }),
    ]);

    const result = await scanAnalytics(projectsDir, options);
    expect(result.overall.requests).toBe(1);
    expect(result.overall.input).toBe(42);
  });

  it('записи старше окна дней отсекаются', async () => {
    // Файл свежий (mtime сейчас), но запись внутри — годовалой давности.
    writeTranscript('proj-a', 'sess1', [
      assistant({
        ts: recentIso(365 * 24 * 60 * 60 * 1000),
        model: 'claude-opus-4-8',
        cwd: '/work/a',
        sessionId: 's1',
        input: 100,
      }),
    ]);

    const result = await scanAnalytics(projectsDir, options);
    expect(result.overall.requests).toBe(0);
  });

  it('нечисловой days (?days=abc → NaN) не роняет сборку отчёта (регрессия)', async () => {
    // Раньше NaN пролезал в since, фильтры по времени молча пропускали всё, а
    // buildResult падал на `new Date(NaN).toISOString()` — маршрут отвечал 500.
    writeTranscript('proj-a', 'sess1', [
      assistant({
        ts: recentIso(),
        model: 'claude-opus-4-8',
        cwd: '/work/a',
        sessionId: 's1',
        input: 100,
      }),
    ]);

    const result = await scanAnalytics(projectsDir, {
      days: Number.NaN,
      recentSessionsLimit: 10,
    });

    // Не бросает и отдаёт валидные границы периода: мусорный ввод трактуется
    // как период по умолчанию (30 дней), запись за последний час учтена.
    expect(Number.isNaN(Date.parse(result.from))).toBe(false);
    expect(Number.isNaN(Date.parse(result.to))).toBe(false);
    expect(result.overall.requests).toBe(1);
  });

  it('день и час одной записи считаются в одном (локальном) поясе', async () => {
    // Момент у границы суток: в поясах со смещением UTC-дата и локальная дата
    // расходятся. byDay и byHour должны опираться на одно локальное время, иначе
    // запись попала бы в «день» и «час» из разных суток («грабля -1 день»).
    const ts = '2026-07-15T23:30:00.000Z';
    const local = new Date(ts);
    const dir = join(projectsDir, 'proj-a');
    mkdirSync(dir, { recursive: true });
    // mtime свежий, чтобы файл не отсёкся; запись внутри — с фиксированной датой,
    // но в окне «за всё время».
    writeFileSync(
      join(dir, 'sess1.jsonl'),
      JSON.stringify(
        assistant({ ts, model: 'claude-opus-4-8', cwd: '/work/a', sessionId: 's1', input: 1 }),
      ) + '\n',
    );

    const result = await scanAnalytics(projectsDir, { days: 36_500, recentSessionsLimit: 10 });
    // День — локальная дата момента (в UTC это дало бы 2026-07-15, что в поясах
    // с положительным смещением разошлось бы с локальным часом).
    expect(result.byDay[0]?.date).toBe(localDay(ts));
    // Единственная активная корзина часа — локальный час того же момента.
    const activeHour = result.byHour.find((bucket) => bucket.requests > 0);
    expect(activeHour?.hour).toBe(local.getHours());
    // И день, и час выведены из одного локального времени — они не из разных суток.
    expect(result.byDay[0]?.date).toBe(localDay(local.toISOString()));
  });

  it('byHour всегда 24 корзины', async () => {
    writeTranscript('proj-a', 'sess1', [
      assistant({
        ts: recentIso(),
        model: 'claude-opus-4-8',
        cwd: '/work/a',
        sessionId: 's1',
        input: 1,
      }),
    ]);
    const result = await scanAnalytics(projectsDir, options);
    expect(result.byHour).toHaveLength(24);
    expect(result.byHour.reduce((s, h) => s + h.requests, 0)).toBe(1);
  });
});
