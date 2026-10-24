import type { GroupSignal, GroupWatch, GroupWatchRule } from '@agentdeck/contracts/group-watch';
import { commandSteps } from '../check-signature.ts';
import { MINUTE_MS, minutes } from '../rules-util.ts';
import type { RuleHit } from '../watch.types.ts';

/**
 * R23 (A6): одна и та же беда в нескольких группах плана — причина общая (стенд,
 * сервис, сломанная проверка), а не в группе. Чистая функция над активными
 * сигналами групп одного разделения: застрявший вызов (R15, R16) или повтор падения
 * (R24) с той же командой в разных группах за окно `crossGroupMinutes`. Повтор
 * проверки (R4) сюда не входит (F-114): три группы, каждая гоняющая свой `pnpm lint`
 * без правки, — три привычки, а не одна поломка стенда.
 */

/** Правила, чья команда сравнивается между группами. */
export const CORRELATED: ReadonlySet<GroupWatchRule> = new Set(['R15', 'R16', 'R24']);
const CD_STEP = /^(?:cd|pushd)\s/;

/**
 * Ключ сверки между группами: отпечаток полной команды (`params.sig`, F-89), а у
 * сигнала без него (запись до отпечатков) — подпись строки сигнала.
 */
export function correlationKey(signal: Pick<GroupSignal, 'params'>): string | undefined {
  const print = signal.params?.sig;
  return print ? `#${print}` : signalSignature(signal);
}

/** Ключ, по которому записан сам R23: тот же, что у сведённых им сигналов. */
export function r23Key(signal: Pick<GroupSignal, 'params'>): string | undefined {
  const print = signal.params?.sig;
  return print ? `#${print}` : signal.params?.command;
}

/**
 * Подпись команды сигнала: шаги без перехода в каталог (у каждой группы своя копия),
 * пробелы схлопнуты, хвостовое «…» маски срезано. Нет команды — `undefined`.
 */
export function signalSignature(signal: Pick<GroupSignal, 'params'>): string | undefined {
  const raw = signal.params?.command ?? signal.params?.call;
  if (!raw) return undefined;
  const body = raw.replace(/\s*…\s*$/u, '').trim();
  if (!body) return undefined;
  const steps = commandSteps(body).filter((step) => !CD_STEP.test(step));
  const text = (steps.length > 0 ? steps.join(' && ') : body).replace(/\s+/g, ' ').trim();
  return text || undefined;
}

/**
 * Попадания R23 по группам одного плана: номер группы → попадание. Группа попадает,
 * когда её команда активна ещё хотя бы в `crossGroupCount - 1` других группах и
 * первые появления укладываются в окно. Группа с несколькими общими командами
 * получает ту, что охватила больше групп.
 */
export function correlateGroups(
  signalsByGroup: ReadonlyMap<number, readonly GroupSignal[]>,
  settings: GroupWatch,
  now: number,
): Map<number, RuleHit> {
  // Ключ → номер группы → когда эта команда впервые замечена в группе.
  const bySig = new Map<string, Map<number, number>>();
  // Ключ → что показать: подпись строки сигнала (отпечаток человеку ничего не скажет).
  const shown = new Map<string, string>();
  for (const [index, signals] of signalsByGroup) {
    for (const signal of signals) {
      if (signal.clearedAt || !CORRELATED.has(signal.rule)) continue;
      const key = correlationKey(signal);
      const at = Date.parse(signal.at);
      if (!key || !Number.isFinite(at)) continue;
      const groups = bySig.get(key) ?? new Map<number, number>();
      groups.set(index, Math.min(groups.get(index) ?? at, at));
      bySig.set(key, groups);
      if (!shown.has(key)) shown.set(key, signalSignature(signal) ?? '');
    }
  }
  const span = settings.crossGroupMinutes * MINUTE_MS;
  const out = new Map<number, RuleHit>();
  for (const [key, groups] of bySig) {
    const firsts = [...groups].sort((a, b) => a[1] - b[1]);
    // Самое широкое окно длиной `span` по первым появлениям.
    let best: Array<[number, number]> = [];
    for (let start = 0; start < firsts.length; start += 1) {
      const from = firsts[start]?.[1] ?? 0;
      const inside = firsts.slice(start).filter(([, at]) => at - from <= span);
      if (inside.length > best.length) best = inside;
    }
    if (best.length < settings.crossGroupCount) continue;
    const first = best[0]?.[1] ?? now;
    const last = best.at(-1)?.[1] ?? now;
    const hit: RuleHit = {
      rule: 'R23',
      severity: 'alert',
      numbers: { groups: best.length, spanMin: Math.max(1, minutes(last - first)) },
      params: {
        command: shown.get(key) ?? '',
        ...(key.startsWith('#') ? { sig: key.slice(1) } : {}),
      },
      since: first,
    };
    for (const [index] of best) {
      const held = out.get(index);
      if (!held || (held.numbers.groups ?? 0) < best.length) out.set(index, hit);
    }
  }
  return out;
}
