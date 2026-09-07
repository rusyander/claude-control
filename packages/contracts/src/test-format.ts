/**
 * Разбор и раскладка тест-кейсов — то, что нужно ОБЕИМ сторонам одинаково.
 *
 * Сервер, веб и телефон читают одни и те же файлы `.agent/tests/`, и все трое
 * обязаны понимать их одинаково: где шаг строкой, а где объектом; какой статус
 * считать зелёным; во сколько проходов разворачивается кейс с параметрами.
 * Три копии этих правил расходятся молча — кейс, который панель показывает
 * пройденным, в отчёте оказывается непроверенным.
 *
 * ВАЖНО про импорт на сервере (та же причина, что у `uploads`): сервер идёт под
 * `node --experimental-strip-types` и ЗНАЧЕНИЯ из бочки `@agentdeck/contracts`
 * брать не может — её реэкспорты без расширений Node не резолвит. Поэтому файл
 * самодостаточен (ни одного импорта, типы описаны структурно) и вынесен в
 * отдельную точку экспорта `@agentdeck/contracts/test-format`. Не добавлять
 * сюда импорты: сервер перестанет стартовать.
 */

/** Шаг в том виде, в каком он лежит в файле. */
export interface StepShape {
  action: string;
  expected?: string;
  data?: string;
  ref?: string;
}

/** Статусы в каноническом порядке — от «не знаем» к «мешает чужое». */
export const TEST_STATUSES = ['unknown', 'running', 'passed', 'failed', 'skipped', 'blocked'];

/** Важности от самой высокой к самой низкой: порядок задаёт сортировку отбора. */
export const TEST_PRIORITIES = ['blocker', 'high', 'medium', 'low'];

/** Слова, которыми агент и чужие форматы называют результат. */
const STATUS_WORDS: Record<string, string> = {
  ok: 'passed',
  pass: 'passed',
  passed: 'passed',
  success: 'passed',
  successful: 'passed',
  fail: 'failed',
  failed: 'failed',
  failure: 'failed',
  error: 'failed',
  broken: 'failed',
  skip: 'skipped',
  skipped: 'skipped',
  pending: 'unknown',
  unknown: 'unknown',
  running: 'running',
  blocked: 'blocked',
  block: 'blocked',
};

/** Статус из чужого слова. Неизвестное — `unknown`, а не молчаливый провал. */
export function toStatus(value: unknown): string {
  const word = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return STATUS_WORDS[word] ?? 'unknown';
}

/** Считается ли статус завершённым результатом (а не ожиданием). */
export function isFinalStatus(status: string): boolean {
  return status === 'passed' || status === 'failed' || status === 'skipped' || status === 'blocked';
}

/** Шаг из сырых данных: строка, объект или мусор. */
export function toStep(raw: unknown): StepShape | undefined {
  if (typeof raw === 'string') {
    const action = raw.trim();
    return action ? { action } : undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Record<string, unknown>;
  const action = typeof item.action === 'string' ? item.action.trim() : '';
  const ref = typeof item.ref === 'string' ? item.ref.trim() : '';
  if (!action && !ref) return undefined;
  const step: StepShape = { action: action || `Общий шаг ${ref}` };
  if (typeof item.expected === 'string' && item.expected.trim())
    step.expected = item.expected.trim();
  if (typeof item.data === 'string' && item.data.trim()) step.data = item.data.trim();
  if (ref) step.ref = ref;
  return step;
}

/** Список шагов из чего угодно: массива, строки с переводами строк, мусора. */
export function toSteps(raw: unknown): StepShape[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => toStep(item)).filter((item): item is StepShape => item !== undefined);
  }
  if (typeof raw === 'string') {
    return raw
      .split('\n')
      .map((line) => toStep(line))
      .filter((item): item is StepShape => item !== undefined);
  }
  return [];
}

/** Шаг одной строкой — для промпта агенту, поиска и узких списков. */
export function stepText(step: StepShape): string {
  const parts = [step.action];
  if (step.data) parts.push(`данные: ${step.data}`);
  if (step.expected) parts.push(`ожидание: ${step.expected}`);
  return parts.join(' · ');
}

/** Раскрытие ссылок на общие шаги. Неизвестная ссылка остаётся подписью. */
export function expandSteps(
  steps: StepShape[],
  shared: { id: string; steps: StepShape[] }[],
): StepShape[] {
  const map = new Map(shared.map((item) => [item.id, item.steps]));
  const result: StepShape[] = [];
  for (const step of steps) {
    const nested = step.ref ? map.get(step.ref) : undefined;
    if (nested) result.push(...nested.map((item) => ({ ...item })));
    else result.push(step);
  }
  return result;
}

/** Имена параметров, использованных в шагах (`%login`). */
export function parametersInSteps(steps: StepShape[]): string[] {
  const found = new Set<string>();
  for (const step of steps) {
    const text = `${step.action} ${step.expected ?? ''} ${step.data ?? ''}`;
    for (const match of text.matchAll(/%([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found];
}

/** Подстановка значений параметров в текст шага. */
export function applyParams(text: string, params: Record<string, string>): string {
  return text.replace(
    /%([A-Za-z_][A-Za-z0-9_]*)/g,
    (whole: string, name: string) => params[name] ?? whole,
  );
}

/**
 * Все комбинации значений параметров.
 *
 * Полный перебор растёт как произведение и на трёх параметрах по три значения
 * даёт 27 проходов; `pairwise` сжимает его до набора, где каждая ПАРА значений
 * встречается хотя бы раз, — это и есть попарное тестирование.
 */
export function combineParams(
  parameters: { name: string; values: string[] }[],
  mode: 'full' | 'pairwise' = 'full',
): Record<string, string>[] {
  const usable = parameters.filter((item) => item.name && item.values.length > 0);
  if (usable.length === 0) return [];
  if (mode === 'full' || usable.length < 3) {
    let combos: Record<string, string>[] = [{}];
    for (const parameter of usable) {
      const next: Record<string, string>[] = [];
      for (const combo of combos) {
        for (const value of parameter.values) next.push({ ...combo, [parameter.name]: value });
      }
      combos = next;
    }
    return combos;
  }

  // Жадный pairwise: берём полный перебор и оставляем только те строки,
  // которые закрывают ещё не покрытые пары. Для десятка параметров этого
  // достаточно, а внешняя библиотека ради такого не нужна.
  const full = combineParams(usable, 'full');
  const pairs = new Set<string>();
  for (let i = 0; i < usable.length; i += 1) {
    const first = usable[i];
    if (!first) continue;
    for (let j = i + 1; j < usable.length; j += 1) {
      const second = usable[j];
      if (!second) continue;
      for (const left of first.values) {
        for (const right of second.values) {
          pairs.add(`${first.name}=${left}|${second.name}=${right}`);
        }
      }
    }
  }
  const chosen: Record<string, string>[] = [];
  for (const combo of full) {
    const covered: string[] = [];
    const names = Object.keys(combo);
    for (let i = 0; i < names.length; i += 1) {
      const first = names[i];
      if (!first) continue;
      for (let j = i + 1; j < names.length; j += 1) {
        const second = names[j];
        if (!second) continue;
        const key = `${first}=${combo[first]}|${second}=${combo[second]}`;
        if (pairs.has(key)) covered.push(key);
      }
    }
    if (covered.length === 0) continue;
    for (const key of covered) pairs.delete(key);
    chosen.push(combo);
    if (pairs.size === 0) break;
  }
  return chosen;
}

/** Ключ тест-поинта: кейс, окружение и значения параметров. */
export function pointId(
  groupId: string,
  caseId: string,
  environmentId?: string,
  params?: Record<string, string>,
): string {
  const tail = params
    ? Object.keys(params)
        .sort()
        .map((name) => `${name}=${params[name]}`)
        .join(',')
    : '';
  return [groupId, caseId, environmentId ?? '', tail].filter(Boolean).join('|');
}

/** Пустая сводка прогона — из неё складывают счёт по результатам. */
export function emptySummary(): {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  blocked: number;
} {
  return { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0 };
}

/** Сводка по списку результатов. */
export function summarize(results: { status: string }[]): {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  blocked: number;
} {
  const summary = emptySummary();
  for (const result of results) {
    summary.total += 1;
    if (result.status === 'passed') summary.passed += 1;
    if (result.status === 'failed') summary.failed += 1;
    if (result.status === 'skipped') summary.skipped += 1;
    if (result.status === 'blocked') summary.blocked += 1;
  }
  return summary;
}

/**
 * Стабильность кейса по истории: доля прогонов БЕЗ смены результата.
 *
 * Считается так же, как это принято в TMS: смотрим последовательность
 * результатов одного кейса и делим число смен на число переходов. Кейс, который
 * всегда даёт одно и то же, стабилен на 100%.
 */
export function stabilityOf(statuses: string[]): { stability: number; flips: number } {
  const final = statuses.filter((status) => isFinalStatus(status));
  if (final.length < 2) return { stability: 100, flips: 0 };
  let flips = 0;
  for (let i = 1; i < final.length; i += 1) {
    if (final[i] !== final[i - 1]) flips += 1;
  }
  const stability = Math.round((1 - flips / (final.length - 1)) * 100);
  return { stability, flips };
}
