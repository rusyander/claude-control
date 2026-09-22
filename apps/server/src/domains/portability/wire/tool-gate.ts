import type { ConfigProvider } from '../../../providers/types.ts';
import type { SupervisorHook } from '../supervisor/run.ts';
import type { SupervisorRun } from '../supervisor/payload.ts';
import { runToolEvent, type WireToolDecision } from './tool-events.ts';

/**
 * ВОРОТА ВЫЗОВА для одного прогона (П4.1).
 *
 * Шлюз видит вызов инструмента в теле ответа, но не знает ни чьи скрипты на нём
 * исполнять, ни какого CLI этот прогон. Единственное, что приезжает с запросом,
 * — метка прогона в адресе (`/_run/<метка>/v1/…`): другого канала от процесса
 * чужого CLI к панели нет. Здесь эта метка и превращается в набор хуков.
 *
 * Реестр держится в памяти намеренно. Запись живёт ровно столько, сколько идёт
 * прогон, и переживать перезапуск панели ей незачем: прогон его тоже не
 * переживает (усыновлённый доигрывает события конца — своих вызовов у него уже
 * нет). Запись, сохранённая на диск, наоборот, означала бы ворота, открытые
 * метке, которой никто больше не пользуется.
 */

/** Чьи хуки исполняет провод в этом прогоне. */
export interface ToolGateRun {
  readonly provider: ConfigProvider;
  readonly run: SupervisorRun;
  readonly hooks: readonly SupervisorHook[];
  readonly timeoutMs?: number;
}

/**
 * Вызов в том виде, в каком его видит ШЛЮЗ (`tool-shim/parse.ts → ShimCall`).
 *
 * Объявлен здесь, а не взят импортом: тянуть разборщик кадров в надзиратель
 * значило бы связать два домена ради трёх полей. Но и назвать поля по-своему
 * нельзя — именно на этом шве родился дефект, который поймала
 * `check-tool-shim-hooks.mjs`: у шлюза аргументы зовутся `arguments`, у нагрузки
 * Claude — `tool_input`, и ворота, объявленные в словах нагрузки, получали от
 * шлюза `undefined`. Скрипт видел вызов без аргументов и разрешал ВСЁ — молча,
 * потому что двусторонняя совместимость методов TypeScript такую подмену не
 * ловит.
 */
export interface GatewayToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** То, что спрашивает шлюз: один вопрос про один вызов. */
export interface ToolGate {
  decide(call: GatewayToolCall): Promise<{ allow: boolean; reason?: string }>;
}

/**
 * Ворота из описания прогона. Условие `throughContour` здесь не параметр и не
 * догадка: ворота спрашивают ТОЛЬКО с пути запроса шлюза, то есть трафик через
 * контур уже идёт — иначе спрашивать было бы некому.
 */
export function toolGateOf(
  target: ToolGateRun,
  /** Полный исход события — для следа прогона; отказ и так виден в ответе. */
  onOutcome?: (decision: WireToolDecision) => void,
): ToolGate {
  return {
    async decide(call) {
      const decision = await runToolEvent({
        provider: target.provider,
        run: target.run,
        // Перевод слов шлюза в слова нагрузки — здесь, на шве, и ровно один раз.
        call: { id: call.id, name: call.name, input: call.arguments },
        event: 'PreToolUse',
        hooks: target.hooks,
        conditions: { throughContour: true },
        ...(target.timeoutMs === undefined ? {} : { timeoutMs: target.timeoutMs }),
      });
      onOutcome?.(decision);
      return decision.allow
        ? { allow: true }
        : { allow: false, ...(decision.reason ? { reason: decision.reason } : {}) };
    },
  };
}

/**
 * Несколько ворот на одном прогоне: хуки человека (П4.1) и брокер прав (П4.2).
 *
 * Спрашиваются ПО ОЧЕРЕДИ и до первого отказа — не ради экономии, а потому что
 * второй вопрос после отказа уже ничего не решает, а побочные действия скрипта
 * человека совершает настоящие. Причина уезжает от тех ворот, которые отказали:
 * человеку нужно знать, ЧТО именно остановило вызов, а не что «что-то».
 *
 * Пустой список — это ворота, которые всё пропускают, и заводить их незачем:
 * реестр отдаёт `undefined`, и прослойка работает как без ворот вовсе.
 */
export function allToolGates(gates: readonly ToolGate[]): ToolGate | undefined {
  if (gates.length === 0) return undefined;
  if (gates.length === 1) return gates[0];
  return {
    async decide(call) {
      for (const gate of gates) {
        const decision = await gate.decide(call);
        if (!decision.allow) return decision;
      }
      return { allow: true };
    },
  };
}

/**
 * ОТКРЫВАЕТ ли панель ворота на пути запроса сегодня.
 *
 * Реестр ниже собран, прослойка его спрашивает (`runtime.ts`: `setToolGate`), а
 * `open()` не зовёт никто: ворота остаются пустыми в любом прогоне, и правило
 * прав или хук вызова инструмента не принуждается даже через контур.
 *
 * Флаг существует ради ОДНОГО потребителя — отчёта верности: без него экран
 * обещал бы уровень «проводом» с условием «включите контур», а включённый контур
 * ничего не меняет. Решение владельца (22.09.2026): пока провод не подключён,
 * экран говорит это вслух, а не обещает принуждение, которого нет.
 *
 * Когда врезка появится (прогон открывает ворота на старте и закрывает на
 * конце), флаг становится `true` ТЕМ ЖЕ коммитом — иначе отчёт начнёт врать в
 * другую сторону, занижая то, что уже работает.
 */
export const REQUEST_PATH_GATE_OPENED = false;

/**
 * Открытые прогоны по метке.
 *
 * Ворот НЕТ по умолчанию: метка без записи — обычный запрос, и придерживать его
 * вызовы незачем. Ровно поэтому реестр отвечает `undefined`, а не «пустыми
 * воротами, которые всё пропускают»: прослойка спрашивает включённость провода
 * до первого кадра, и пустые ворота заставили бы её ждать решения, которого
 * никто не примет.
 */
export class ToolGateRegistry {
  #open = new Map<string, ToolGate>();

  /** Прогон начался: его метка получает ворота. */
  open(runTag: string, gate: ToolGate): void {
    if (!runTag) return;
    this.#open.set(runTag, gate);
  }

  /**
   * Прогон кончился — как угодно, включая падение и остановку человеком.
   * Оставленная запись это ворота, которые исполняют скрипты для прогона,
   * которого уже нет.
   */
  close(runTag: string): void {
    this.#open.delete(runTag);
  }

  gateOf(runTag: string): ToolGate | undefined {
    return this.#open.get(runTag);
  }

  /** Сколько прогонов сейчас открыто — для следа и для тестов. */
  get size(): number {
    return this.#open.size;
  }
}
