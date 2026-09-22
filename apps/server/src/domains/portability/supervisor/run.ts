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

/**
 * Сколько знаков причины берётся из stderr скрипта. Причина уезжает и человеку в
 * заметку, и модели в ответ (провод П4.1 ставит её на место запрещённого вызова),
 * а скрипт волен напечатать туда весь свой отладочный вывод.
 */
const MAX_REASON_CHARS = 1_000;

/** Один скрипт, который панель отыгрывает на событии. */
export interface SupervisorHook {
  readonly event: SupervisorEvent;
  /** Команда в том виде, в каком её хранит панель (она же уходит оболочке). */
  readonly command: string;
  /** Персональный таймаут этого скрипта; не задан — общий. */
  readonly timeoutMs?: number;
  /**
   * Чей это скрипт (П6.2).
   *
   * `target` (умолчание) — запись живёт в файлах самой цели, и владельца события
   * решает `hookEventOwner`: есть событие у CLI — отыгрывает он, надзиратель
   * молчит, иначе хук сработал бы дважды.
   *
   * `panel` — собственный механизм панели (калитка запросов, триггер сценария
   * группы). В файлы чужого CLI он не записывается НИКОГДА, поэтому продублировать
   * его целью нечем, и отыгрывается он даже на родном для цели событии. Без этого
   * калитка молча ничего не делала бы у `qwen` и `kimi` — единственных, у кого
   * `UserPromptSubmit` свой.
   */
  readonly owner?: 'target' | 'panel';
}

/**
 * События, у которых обычный stdout скрипта — это КОНТЕКСТ, а не лог.
 *
 * Так устроено у Claude: на `UserPromptSubmit` и `SessionStart` всё, что хук
 * напечатал, дописывается в контекст, и скрипт, снятый с Claude, печатает туда
 * простой текст, а не JSON. Без этой пары надзиратель терял бы напечатанное
 * молча — а это ровно то, ради чего такой хук и пишут (П6.2: триггер сценария
 * группы кладёт в контекст напоминание о порядке работы).
 */
const STDOUT_IS_CONTEXT: ReadonlySet<SupervisorEvent> = new Set([
  'UserPromptSubmit',
  'SessionStart',
]);

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

  // Событие есть у самой цели — её скрипты отыгрывает она, и надзиратель к ним не
  // прикасается. Собственные записи панели (`owner: 'panel'`) в файлах цели не
  // лежат и продублированы быть не могут, поэтому идут в любом случае.
  const applicable = hooks.filter(
    (hook) => hook.event === event && (owner === 'supervisor' || hook.owner === 'panel'),
  );
  if (applicable.length === 0) {
    // Пустой результат здесь означает «надзирателю нечего отыгрывать»,
    // а не «скриптов у человека нет».
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

  for (const hook of applicable) {
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

    // Причина отказа по коду 2 — это STDERR скрипта: так устроен канал у Claude,
    // и перенесённый скрипт пишет объяснение именно туда. Без этой строки отказ
    // доезжал до человека и до модели словами панели («хук вышел с кодом 2»), то
    // есть правило оставалось без объяснения ровно там, где объяснение и нужно.
    // Явный JSON сильнее: он — осознанный канал, а stderr пишут и ради отладки.
    //
    // ЛЮБОЙ другой ненулевой код — уже не решение хука, а его поломка (нет
    // интерпретатора, упал, оболочка не нашла команду), и план требует для неё
    // «код выхода и хвост вывода» (§7): без хвоста человек читал бы «завершился
    // с кодом 127» и шёл смотреть тот же вывод руками. Поэтому код НАЗЫВАЕТСЯ
    // панелью, а слова остаются скрипту.
    const said = script.stderr.trim().slice(0, MAX_REASON_CHARS);
    const brokeWithCode = parsed === undefined && script.exitCode !== 0 && said;
    const hookReason = script.timedOut
      ? `Хук события ${event} не ответил за ${hook.timeoutMs ?? defaultTimeout} мс и был снят`
      : ((brokeWithCode
          ? script.exitCode === 2
            ? said
            : `Хук завершился с кодом ${script.exitCode}: ${said}`
          : undefined) ?? verdict.reason);

    // Обычный вывод отработавшего скрипта на событии, где stdout — это контекст.
    // Явный JSON сильнее: он назван осознанно, а печатать простой текст умеет и
    // скрипт, который просто рассказывает о себе.
    const printed = script.stdout.trim();
    const context =
      verdict.addedContext ??
      (STDOUT_IS_CONTEXT.has(event) &&
      !script.timedOut &&
      script.exitCode === 0 &&
      parsed === undefined &&
      printed
        ? printed
        : undefined);

    results.push({
      event,
      command: hook.command,
      exitCode: script.exitCode,
      decision: verdict.decision,
      ...(hookReason ? { reason: hookReason } : {}),
      ...(context ? { addedContext: context } : {}),
      timedOut: script.timedOut,
      durationMs: script.durationMs,
      ignoredOnObservingEvent: intervened && !canBlock,
    });

    if (context) addedContext.push(context);

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
