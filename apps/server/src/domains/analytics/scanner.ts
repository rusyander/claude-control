import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import type {
  Analytics,
  DailyUsage,
  HourlyActivity,
  ModelUsage,
  ProjectUsage,
  SessionUsage,
  TokenTotals,
  ToolUsage,
} from '@claude-control/contracts';
import { estimateCost, type ModelPricing, type PricingEntry } from './pricing.ts';

/**
 * Сканер транскриптов. Файлы читаются построчно потоком: их больше тысячи,
 * отдельные весят десятки мегабайт, и читать их целиком в память нельзя.
 *
 * Строки, которые не разбираются, просто пропускаются: транскрипт активной
 * сессии может дописываться прямо во время чтения, и последняя строка
 * оказывается обрезанной — это нормально, а не повод падать.
 */

/** Сессия считается активной, если её файл менялся за последние 10 минут. */
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface RawEntry {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  message?: {
    model?: string;
    usage?: RawUsage;
    content?: Array<{ type?: string; name?: string }>;
  };
}

function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, requests: 0 };
}

function addUsage(target: TokenTotals, usage: RawUsage): void {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;

  target.input += input;
  target.output += output;
  target.cacheRead += cacheRead;
  target.cacheCreation += cacheCreation;
  target.total += input + output + cacheRead + cacheCreation;
  target.requests += 1;
}

interface Accumulator {
  overall: TokenTotals;
  cost: number;
  byModel: Map<string, { totals: TokenTotals; cost: number }>;
  byDay: Map<string, { totals: TokenTotals; cost: number }>;
  byProject: Map<
    string,
    { totals: TokenTotals; cost: number; sessions: Set<string>; lastActivity: string }
  >;
  byHour: Map<number, { requests: number; tokens: number }>;
  sessions: Map<string, SessionUsage>;
  tools: Map<string, number>;
}

export interface ScanOptions {
  /** Сколько последних дней учитывать. Ограничение бережёт время сканирования. */
  days: number;
  /** Сколько сессий вернуть в списке последних. */
  recentSessionsLimit: number;
  /** Свои тарифы из настроек: фрагмент имени модели → цена за миллион токенов. */
  pricing?: Record<string, ModelPricing>;
  /** Прайс, по которому считать. Пусто — встроенная запасная таблица. */
  pricingEntries?: PricingEntry[];
}

export async function scanAnalytics(
  projectsDir: string,
  options: ScanOptions,
): Promise<Omit<Analytics, 'runningAgents' | 'topSkills'>> {
  const startedAt = Date.now();
  // days из запроса может прийти мусором (`?days=abc` → NaN). Без защиты since
  // становится NaN, фильтры по времени молча пропускают всё, а сборка отчёта
  // падает на `new Date(NaN).toISOString()` — маршрут отвечает 500. Непонятный
  // ввод трактуем как период по умолчанию.
  const days = Number.isFinite(options.days) ? options.days : 30;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  const accumulator: Accumulator = {
    overall: emptyTotals(),
    cost: 0,
    byModel: new Map(),
    byDay: new Map(),
    byProject: new Map(),
    byHour: new Map(),
    sessions: new Map(),
    tools: new Map(),
  };

  const files = collectTranscripts(projectsDir, since);
  for (const file of files) await scanFile(file, since, accumulator, options);

  return buildResult(accumulator, options, files.length, Date.now() - startedAt, since);
}

/** Собирает пути транскриптов, отсекая старые по времени изменения файла. */
function collectTranscripts(
  projectsDir: string,
  since: number,
): Array<{ path: string; mtimeMs: number }> {
  if (!existsSync(projectsDir)) return [];
  const result: Array<{ path: string; mtimeMs: number }> = [];

  for (const projectEntry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const projectPath = join(projectsDir, projectEntry.name);

    for (const fileEntry of readdirSync(projectPath, { withFileTypes: true })) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue;

      const filePath = join(projectPath, fileEntry.name);
      const stats = statSync(filePath);
      // Файл, не менявшийся с начала периода, точно не содержит свежих записей.
      if (stats.mtimeMs < since) continue;
      result.push({ path: filePath, mtimeMs: stats.mtimeMs });
    }
  }

  return result;
}

async function scanFile(
  file: { path: string; mtimeMs: number },
  since: number,
  acc: Accumulator,
  options: Pick<ScanOptions, 'pricing' | 'pricingEntries'>,
): Promise<void> {
  const isActive = Date.now() - file.mtimeMs < ACTIVE_WINDOW_MS;
  const stream = createReadStream(file.path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;

    let entry: RawEntry;
    try {
      entry = JSON.parse(line) as RawEntry;
    } catch {
      continue; // недописанная строка активной сессии
    }

    countTools(entry, acc);

    const usage = entry.message?.usage;
    if (entry.type !== 'assistant' || !usage || !entry.timestamp) continue;

    const time = new Date(entry.timestamp).getTime();
    if (Number.isNaN(time) || time < since) continue;

    const model = entry.message?.model ?? 'unknown';
    const tokens = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheCreation: usage.cache_creation_input_tokens ?? 0,
    };
    // Цену берём НА МОМЕНТ записи, а не на сегодня: у части моделей цена
    // менялась по расписанию (вводная цена Sonnet 5), и пересчёт старого
    // расхода по сегодняшнему прайсу дал бы неверную историю.
    const cost = estimateCost(model, tokens, {
      overrides: options.pricing,
      entries: options.pricingEntries,
      at: time,
    });

    addUsage(acc.overall, usage);
    acc.cost += cost;

    upsert(acc.byModel, model, usage, cost);
    // byDay берётся по ЛОКАЛЬНОЙ дате — как и час ниже (getHours). Иначе одна и
    // та же запись у пользователя в поясе ≠ UTC попадала бы в «день» и «час» из
    // разных суток. На цену это не влияет: стоимость считается по абсолютному
    // моменту записи (estimateCost выше, at: time), а не по ключу группировки.
    upsert(acc.byDay, localDay(entry.timestamp), usage, cost);

    const hour = new Date(entry.timestamp).getHours();
    const hourly = acc.byHour.get(hour) ?? { requests: 0, tokens: 0 };
    hourly.requests += 1;
    hourly.tokens += tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
    acc.byHour.set(hour, hourly);

    trackProject(acc, entry, usage, cost);
    trackSession(acc, entry, usage, cost, model, isActive, file.path);
  }
}

function upsert(
  map: Map<string, { totals: TokenTotals; cost: number }>,
  key: string,
  usage: RawUsage,
  cost: number,
): void {
  const bucket = map.get(key) ?? { totals: emptyTotals(), cost: 0 };
  addUsage(bucket.totals, usage);
  bucket.cost += cost;
  map.set(key, bucket);
}

function trackProject(acc: Accumulator, entry: RawEntry, usage: RawUsage, cost: number): void {
  const project = normalizeProject(entry.cwd ?? 'unknown');
  const bucket = acc.byProject.get(project) ?? {
    totals: emptyTotals(),
    cost: 0,
    sessions: new Set<string>(),
    lastActivity: entry.timestamp ?? '',
  };

  addUsage(bucket.totals, usage);
  bucket.cost += cost;
  if (entry.sessionId) bucket.sessions.add(entry.sessionId);
  if (entry.timestamp && entry.timestamp > bucket.lastActivity)
    bucket.lastActivity = entry.timestamp;

  acc.byProject.set(project, bucket);
}

function trackSession(
  acc: Accumulator,
  entry: RawEntry,
  usage: RawUsage,
  cost: number,
  model: string,
  isActive: boolean,
  filePath: string,
): void {
  const sessionId = entry.sessionId ?? basename(filePath, '.jsonl');
  const existing = acc.sessions.get(sessionId);

  if (!existing) {
    const totals = emptyTotals();
    addUsage(totals, usage);
    acc.sessions.set(sessionId, {
      sessionId,
      project: normalizeProject(entry.cwd ?? 'unknown'),
      displayName: shortenProject(entry.cwd ?? 'unknown'),
      startedAt: entry.timestamp ?? '',
      lastActivity: entry.timestamp ?? '',
      totals,
      estimatedCost: cost,
      models: [model],
      gitBranch: entry.gitBranch,
      isActive,
    });
    return;
  }

  addUsage(existing.totals, usage);
  existing.estimatedCost += cost;
  if (!existing.models.includes(model)) existing.models.push(model);
  if (entry.timestamp) {
    if (entry.timestamp > existing.lastActivity) existing.lastActivity = entry.timestamp;
    if (entry.timestamp < existing.startedAt) existing.startedAt = entry.timestamp;
  }
}

/** Считает вызовы инструментов: видно, чем агент реально пользуется. */
function countTools(entry: RawEntry, acc: Accumulator): void {
  for (const part of entry.message?.content ?? []) {
    if (part.type !== 'tool_use' || !part.name) continue;
    acc.tools.set(part.name, (acc.tools.get(part.name) ?? 0) + 1);
  }
}

/**
 * Один и тот же каталог попадает в транскрипты в разном написании: буква диска
 * то строчная, то заглавная, разделители разные. Для Windows это один путь,
 * поэтому приводим к общему виду — иначе проект задваивается в отчёте.
 */
function normalizeProject(cwd: string): string {
  const unified = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

function shortenProject(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || cwd;
}

/**
 * Локальная дата записи в виде `YYYY-MM-DD`. День активности воспринимается по
 * локальным суткам пользователя, поэтому и группировка byDay — по локальному
 * времени, в один пояс с byHour (`getHours`).
 */
function localDay(timestamp: string): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildResult(
  acc: Accumulator,
  options: ScanOptions,
  scannedFiles: number,
  scanDurationMs: number,
  since: number,
): Omit<Analytics, 'runningAgents' | 'topSkills'> {
  const byModel: ModelUsage[] = [...acc.byModel.entries()]
    .map(([model, bucket]) => ({ model, totals: bucket.totals, estimatedCost: bucket.cost }))
    .sort((a, b) => b.totals.total - a.totals.total);

  const byDay: DailyUsage[] = [...acc.byDay.entries()]
    .map(([date, bucket]) => ({ date, totals: bucket.totals, estimatedCost: bucket.cost }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const byProject: ProjectUsage[] = [...acc.byProject.entries()]
    .map(([project, bucket]) => ({
      project,
      displayName: shortenProject(project),
      totals: bucket.totals,
      estimatedCost: bucket.cost,
      sessions: bucket.sessions.size,
      lastActivity: bucket.lastActivity,
    }))
    .sort((a, b) => b.totals.total - a.totals.total);

  const byHour: HourlyActivity[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    requests: acc.byHour.get(hour)?.requests ?? 0,
    tokens: acc.byHour.get(hour)?.tokens ?? 0,
  }));

  const recentSessions = [...acc.sessions.values()]
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
    .slice(0, options.recentSessionsLimit);

  const topTools: ToolUsage[] = [...acc.tools.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const cacheableInput = acc.overall.cacheRead + acc.overall.cacheCreation;

  return {
    from: new Date(since).toISOString(),
    to: new Date().toISOString(),
    overall: acc.overall,
    estimatedCost: acc.cost,
    byModel,
    byDay,
    byProject,
    byHour,
    recentSessions,
    topTools,
    activeSessions: [...acc.sessions.values()].filter((session) => session.isActive).length,
    scannedFiles,
    scanDurationMs,
    cacheHitRatio: cacheableInput > 0 ? acc.overall.cacheRead / cacheableInput : 0,
  };
}
