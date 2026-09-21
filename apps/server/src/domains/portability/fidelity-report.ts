import type { AgentEnvironment, EnvItem } from '@agentdeck/contracts/portable-env';
import {
  countOnlyThroughPanel,
  summarizeFidelity,
  type FidelityReport,
  type FidelityRow,
} from '@agentdeck/contracts/portable-fidelity';
import type { ConfigProvider } from '../../providers/types.ts';
import { describeTarget, level } from './fidelity.ts';
import type { SectionTargets } from './project.ts';

/**
 * Отчёт верности для ВСЕГО паспорта: что будет с каждой записью у выбранной цели
 * (П1.2).
 *
 * Чистая функция над каноном и каталогом: ни чтения диска, ни состояния панели,
 * ни часов — время приходит параметром, иначе тест не смог бы отличить «отчёт
 * посчитан заново» от «прочитан вчерашний».
 *
 * ТРИ РЕШЕНИЯ:
 *
 *  1. **Строка на КАЖДУЮ запись паспорта, включая невозможные.** Отчёт, в
 *     котором нет строки, читается как «эта запись доедет»: потеря молчанием —
 *     ровно то, что инвариант 6 запрещает.
 *  2. **Сводка считается из строк** (`summarizeFidelity`), а не копится по ходу:
 *     второй счётчик рано или поздно разойдётся со строками, и человек увидит
 *     «3 нативно» над двумя нативными строками.
 *  3. **Цель профилируется ОДИН раз** на отчёт (`describeTarget`), а не на
 *     запись: профиль — это чтение каталога, и делать его 200 раз ради 200
 *     одинаковых ответов незачем.
 */
/**
 * Уровень назван, а разделов цели на нём не дали. Отдельный класс, а не голая
 * `Error`: вызывающий обязан уметь отличить «так нельзя» от поломки.
 */
export class FidelityScopeUnsupportedError extends Error {
  readonly scope: string;

  constructor(scope: string) {
    super(`отчёт верности для уровня «${scope}» не считается: разделы цели на нём не названы`);
    this.name = 'FidelityScopeUnsupportedError';
    this.scope = scope;
  }
}

export function buildFidelityReport(
  env: AgentEnvironment,
  target: ConfigProvider,
  computedAt: string,
  /**
   * Разделы ЦЕЛИ на уровне паспорта (П2.5). Профиль каталога описывает дом, и на
   * уровне проекта он обещал бы «нативно» разделу, у которого проектного пути
   * нет вовсе. Глобальному уровню параметр не нужен: там профиль и есть
   * каталог.
   */
  targets?: SectionTargets,
): FidelityReport {
  // Fail-closed: проектный отчёт, посчитанный по ГЛОБАЛЬНЫМ фактам, соврал бы
  // молча — и узнать об этом было бы неоткуда. Уровень назван — назови и его
  // разделы.
  if (env.scope !== 'global' && !targets) throw new FidelityScopeUnsupportedError(env.scope);

  const profile = describeTarget(target, targets);
  const rows = env.items.map((item) => row(item, profile));

  return {
    canonVersion: env.canonVersion,
    source: env.provider,
    target: target.id,
    scope: env.scope,
    computedAt,
    rows,
    summary: summarizeFidelity(rows),
    onlyThroughPanel: countOnlyThroughPanel(rows),
  };
}

/**
 * Строка отчёта = приговор плюс то, о чём он вынесен. `intent` берётся у записи
 * канона: экран раскрывает строку до конкретной записи, и вторую формулировку
 * «для отчёта» здесь заводить нельзя — она начала бы расходиться с паспортом.
 */
function row(item: EnvItem, profile: ReturnType<typeof describeTarget>): FidelityRow {
  return {
    ...level(item, profile),
    itemId: item.id,
    kind: item.kind,
    intent: item.intent,
  };
}
