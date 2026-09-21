import { spawn as nodeSpawn } from 'node:child_process';
import { killChildTree } from '../../../lib/process-tree.ts';
import { readDecision, tryParse } from '../../sandbox/HookDecision.ts';
import type { HookDecision } from '../../sandbox/HookProbe.types.ts';
import type { ConfigProvider } from '../../../providers/types.ts';
import { blockingOfEvent } from '../hook-events.ts';
import {
  encodeSupervisorPayload,
  hookEventOwner,
  type HookEventOwner,
  type SupervisorEvent,
  type SupervisorEventInput,
  type SupervisorRun,
} from './payload.ts';

/**
 * ИСПОЛНЕНИЕ ХУКОВ ВОКРУГ ЧУЖОГО ПРОГОНА (П3.2).
 *
 * Панель запускает чужой CLI, значит она и отыгрывает события, которые отыграл бы
 * Claude: скрипт, снятый с Claude, работает у codex и gemini без правки, хотя
 * механизма хуков у них нет вовсе.
 *
 * Словарь кодов выхода и JSON-вердиктов здесь НЕ заводится: он один и живёт в
 * `sandbox/HookDecision.ts`. Две копии смысла кода 2 однажды уже разошлись на
 * блокирующих событиях (см. шапку `hook-events.ts`) — повторять нечего.
 *
 * Событий инструментов (`PreToolUse`/`PostToolUse`) здесь нет: это П4.
 */

/**
 * Таймаут одного скрипта — столько же, сколько даёт Claude. Зависший хук
 * обязан отпустить прогон, а не держать его вечно.
 */
export const SUPERVISOR_HOOK_TIMEOUT_MS = 60_000;

/** Один скрипт, который панель отыгрывает на событии. */
export interface SupervisorHook {
  readonly event: SupervisorEvent;
  /** Команда в том виде, в каком её хранит панель (она же уходит оболочке). */
  readonly command: string;
  /** Персональный таймаут этого скрипта; не задан — общий. */
  readonly timeoutMs?: number;
}

export interface SupervisorHookResult {
  readonly event: SupervisorEvent;
  readonly command: string;
  readonly exitCode: number;
  readonly decision: HookDecision;
  readonly reason?: string;
  readonly addedContext?: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Скрипт вмешался, но событие наблюдательное — вмешательство не действует. */
  readonly ignoredOnObservingEvent: boolean;
}

export interface SupervisorEventOutcome {
  readonly event: SupervisorEvent;
  /** Кто отыграл событие — строка отчёта, а не догадка вызывающего. */
  readonly owner: HookEventOwner;
  /** Действие отказано: прогон не начинается, и человек видит причину. */
  readonly blocked: boolean;
  /** Причина отказа — её показывают человеку. */
  readonly reason?: string;
  /** Что хуки дописали в контекст (stdout-JSON `additionalContext`). */
  readonly addedContext: readonly string[];
  readonly results: readonly SupervisorHookResult[];
}

export interface RunSupervisorEventParams {
  readonly provider: ConfigProvider;
  readonly run: SupervisorRun;
  readonly input: SupervisorEventInput;
  /** Все скрипты панели; берутся те, что заявлены на это событие. */
  readonly hooks: readonly SupervisorHook[];
  readonly spawnImpl?: typeof nodeSpawn;
  readonly timeoutMs?: number;
}

interface ScriptRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Запуск одного скрипта.
 *
 * Нагрузка уходит ТОЛЬКО через stdin (см. `encodeSupervisorPayload`). Оболочка
 * нужна: команда хука хранится строкой и человек вправе написать в ней конвейер —
 * ровно так её исполняет и Claude, и раздел песочницы.
 */
function runScript(
  command: string,
  payload: string,
  cwd: string,
  timeoutMs: number,
  spawnImpl: typeof nodeSpawn,
): Promise<ScriptRun> {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawnImpl(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: {
        ...process.env,
        // Скрипты берут отсюда каталог проекта — тот же смысл, что у Claude.
        CLAUDE_PROJECT_DIR: cwd,
      },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // Хук запущен через оболочку: на Windows убить нужно дерево, иначе умрёт
      // только `cmd.exe`, а сам скрипт продолжит держать прогон.
      killChildTree(child);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Хук волен не читать stdin и выйти сразу — тогда запись бьёт в закрытый
    // канал и поток бросает `error`. Необработанное событие потока роняет сервер.
    child.stdin?.on('error', () => undefined);

    // Процесс не поднялся вовсе (нет интерпретатора, оболочка не нашла команду).
    // Это не «промолчал»: код -1 уводит решение в `error`, а не в `pass`.
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code ?? 0));

    try {
      child.stdin?.write(payload);
      child.stdin?.end();
    } catch {
      // Вход записать не удалось — решение примем по коду выхода и выводу.
    }
  });
}

/**
 * Отыграть событие.
 *
 * Владелец события ровно один (`hookEventOwner`): есть событие у самого CLI —
 * отыгрывает он, и надзиратель молчит, иначе перенесённый хук срабатывал бы
 * дважды на одно действие.
 *
 * Вмешательство действует только там, где событие УМЕЕТ остановить действие
 * (`blockingOfEvent`). На наблюдательном событии отказ хука записывается в
 * результат и не действует — иначе наблюдатель молча получил бы права запрета.
 *
 * Скрипт, упавший с неизвестным кодом или зависший, прогон не роняет: на
 * наблюдательном событии — fail-open, на блокирующем — fail-closed. Сторона
 * строгости выбрана осознанно: блокирующий хук, который сломался, иначе снял бы
 * запрет молча (инвариант 6), а это худший из двух исходов.
 *
 * Первая блокировка останавливает перебор: прогон всё равно не начнётся, и
 * дальние скрипты работали бы над отменённым действием.
 */
export async function runSupervisorEvent(
  params: RunSupervisorEventParams,
): Promise<SupervisorEventOutcome> {
  const { provider, run, input, hooks } = params;
  const event = input.event;
  const owner = hookEventOwner(provider, event);

  if (owner === 'native') {
    // Событие есть у самой цели — она его и отыграет. Пустой результат здесь
    // означает «надзиратель промолчал», а не «скриптов нет».
    return { event, owner, blocked: false, addedContext: [], results: [] };
  }

  const spawnImpl = params.spawnImpl ?? nodeSpawn;
  const defaultTimeout = params.timeoutMs ?? SUPERVISOR_HOOK_TIMEOUT_MS;
  const canBlock = blockingOfEvent(provider, event) === 'blocks';
  const payload = encodeSupervisorPayload(run, input);

  const results: SupervisorHookResult[] = [];
  const addedContext: string[] = [];
  let blocked = false;
  let reason: string | undefined;

  for (const hook of hooks) {
    if (hook.event !== event) continue;

    const script = await runScript(
      hook.command,
      payload,
      run.cwd,
      hook.timeoutMs ?? defaultTimeout,
      spawnImpl,
    );

    const parsed = tryParse(script.stdout);
    const verdict = readDecision(script.exitCode, parsed);

    // Зависший скрипт решения не вернул — судьба прогона решается тем, умеет ли
    // событие блокировать, а не тем, что успел напечатать убитый процесс.
    const intervened = script.timedOut
      ? true
      : verdict.decision === 'block' || verdict.decision === 'ask' || verdict.decision === 'error';

    const hookReason = script.timedOut
      ? `Хук события ${event} не ответил за ${hook.timeoutMs ?? defaultTimeout} мс и был снят`
      : verdict.reason;

    results.push({
      event,
      command: hook.command,
      exitCode: script.exitCode,
      decision: verdict.decision,
      ...(hookReason ? { reason: hookReason } : {}),
      ...(verdict.addedContext ? { addedContext: verdict.addedContext } : {}),
      timedOut: script.timedOut,
      durationMs: script.durationMs,
      ignoredOnObservingEvent: intervened && !canBlock,
    });

    if (verdict.addedContext) addedContext.push(verdict.addedContext);

    if (intervened && canBlock) {
      blocked = true;
      reason = hookReason ?? `Хук события ${event} отказал действию`;
      break;
    }
  }

  return {
    event,
    owner,
    blocked,
    ...(reason ? { reason } : {}),
    addedContext,
    results,
  };
}
