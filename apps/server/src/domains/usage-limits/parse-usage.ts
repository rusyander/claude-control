import type { UsageLimitWindow } from '@agentdeck/contracts';

/**
 * Разбор ответа `GET https://api.anthropic.com/api/oauth/usage` — того же, что
 * читает CLI для `/usage` (сверено с живым ответом 19.10.2026, CLI 2.1.286).
 *
 * Форма ответа (только то, что берётся):
 *   five_hour / seven_day        — `{ utilization: 0..100, resets_at: ISO }` или `null`;
 *   seven_day_opus / _sonnet     — то же для одной модели (у части аккаунтов `null`);
 *   limits[]                     — `{ kind: session | weekly_all | weekly_scoped, percent,
 *                                    resets_at, is_active, scope.model.display_name }`.
 *
 * Чужую разметку разбираем с правом отказа (`.claude/gotchas.md`, прайс): поле не
 * того типа — окна нет, ни одного окна — `undefined`, и панель покажет «нет
 * данных», а не выдуманное число. Суммы в деньгах не читаются вовсе.
 */

interface RawWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

interface RawLimit {
  kind?: unknown;
  percent?: unknown;
  resets_at?: unknown;
  is_active?: unknown;
  scope?: { model?: { display_name?: unknown } | null } | null;
}

/** Проценты без шума плавающей точки, но и без округления до целых: 3 знака — потолок. */
function cleanPercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 1000) / 1000;
}

function resetOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

function windowOf(raw: unknown): { percent: number; resetsAt: number | null } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { utilization, resets_at } = raw as RawWindow;
  const percent = cleanPercent(utilization);
  return percent === undefined ? undefined : { percent, resetsAt: resetOf(resets_at) };
}

function limitsOf(body: Record<string, unknown>): RawLimit[] {
  const list = body.limits;
  return Array.isArray(list)
    ? list.filter((item): item is RawLimit => !!item && typeof item === 'object')
    : [];
}

function modelName(limit: RawLimit): string | undefined {
  const name = limit.scope?.model?.display_name;
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

/** Окна из ответа; `undefined` — ответ не той формы или окон в нём нет. */
export function parseUsageResponse(body: unknown): UsageLimitWindow[] | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const limits = limitsOf(record);
  const limitOf = (kind: string): RawLimit | undefined => limits.find((l) => l.kind === kind);
  const fromLimit = (limit: RawLimit | undefined) => {
    const percent = cleanPercent(limit?.percent);
    return percent === undefined ? undefined : { percent, resetsAt: resetOf(limit?.resets_at) };
  };
  const activeOf = (limit: RawLimit | undefined) =>
    limit?.is_active === true ? { active: true } : {};

  const windows: UsageLimitWindow[] = [];
  // `utilization` — число с плавающей точкой, `limits[].percent` — целое: первое
  // главнее, второе — запас на случай, если прежние поля уберут.
  const sessionLimit = limitOf('session');
  const session = windowOf(record.five_hour) ?? fromLimit(sessionLimit);
  if (session)
    windows.push({ id: 'session', kind: 'session', ...session, ...activeOf(sessionLimit) });

  const weeklyLimit = limitOf('weekly_all');
  const weekly = windowOf(record.seven_day) ?? fromLimit(weeklyLimit);
  if (weekly) windows.push({ id: 'weekly', kind: 'weekly', ...weekly, ...activeOf(weeklyLimit) });

  const seen = new Set<string>();
  for (const limit of limits) {
    if (limit.kind !== 'weekly_scoped') continue;
    const model = modelName(limit);
    const value = fromLimit(limit);
    if (!model || !value || seen.has(model.toLowerCase())) continue;
    seen.add(model.toLowerCase());
    windows.push({
      id: `weekly:${model}`,
      kind: 'weekly-model',
      model,
      ...value,
      ...activeOf(limit),
    });
  }
  // Прежние поля одной модели — только если `limits[]` эту модель не назвал.
  for (const [field, model] of [
    ['seven_day_opus', 'Opus'],
    ['seven_day_sonnet', 'Sonnet'],
  ] as const) {
    const value = windowOf(record[field]);
    if (!value || seen.has(model.toLowerCase())) continue;
    seen.add(model.toLowerCase());
    windows.push({ id: `weekly:${model}`, kind: 'weekly-model', model, ...value });
  }
  return windows.length > 0 ? windows : undefined;
}
