import type { AskFields } from '@agentdeck/contracts/core/ask';
import { estimateFieldsSchema } from '@agentdeck/contracts/core/estimate';
import { contourModelOf } from '../../platform/routing/core-contour.ts';
import type { CoreChatPort } from '../core-run/core-run.types.ts';
import type { CoreSessionCarry } from '../core-run/session-carry.ts';

/**
 * Разговор чужого CLI, который заводит сам сервер (этап 10, F2c, проход 2): продолжение в чистой
 * сессии и перенос незакрытой работы. Раньше его вёл собственный исполнитель панели
 * (`ProviderChatService`); теперь это задача ядра `chat@1` тем же порядком, что у формы чата
 * (`features/CoreChat`): оценка с пресетом `chat` на месте → выбранный CLI на всю задачу →
 * модель, если известна → запуск. Какие CLI ядро запускает, решает ядро: CLI без переходника
 * получает отказ ядра с его кодом, а не тихий откат на прежний исполнитель.
 */

export interface CoreForeignStart {
  /** id переходника ядра — тот же, что id провайдера панели (`codex`, `qwen`, …). */
  cli: string;
  cwd: string;
  prompt: string;
  /** Имя задачи в ленте ядра; нет — первая строка задания. */
  title?: string;
  model?: string;
  effort?: string;
  /**
   * Первая реплика перед заданием: у чужого CLI инициатива шла первой репликой переписки, а не
   * флагом запуска, — у задачи ядра это начало её запроса.
   */
  preface?: string;
  /**
   * Маршрут контура, когда у активного контура стоит галочка `foreign:<cli>`
   * (`coreContourRoutes`): разрешённый набор задачи тем же ходом, что смена маршрута в чате.
   * Нет — CLI идёт своим провайдером, как человек его настроил. Точный шаблон маршрута — модель
   * задачи вместо `model` (её перевод контуром, `contourModelOf`).
   */
  routes?: NonNullable<AskFields['routes']>;
  /**
   * Слой панели этого разговора (G6, `foreign-carry.ts`): строка о тестах, набор панели для CLI.
   * Поля — в `fields.session` (журнал ядра), значения переменных — телом оценки (память ядра).
   */
  carry?: CoreSessionCarry;
}

/** Поле `routes` для `CoreForeignStart`, только когда маршрут есть. */
export const withRoutes = (
  routes: CoreForeignStart['routes'] | undefined,
): Pick<CoreForeignStart, 'routes'> => (routes?.length ? { routes } : {});

export type CoreForeignOutcome =
  { ok: true; taskId: string } | { ok: false; code: string; message: string };

const TITLE_MAX = 80;

const titleOf = (input: CoreForeignStart): string => {
  const first =
    (input.title ?? '').trim() ||
    (input.prompt
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ??
      'chat');
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
};

export async function startCoreForeignChat(
  port: Pick<CoreChatPort, 'estimate' | 'command'>,
  input: CoreForeignStart,
): Promise<CoreForeignOutcome> {
  const parsed = estimateFieldsSchema.safeParse({
    title: titleOf(input),
    request: input.preface ? `${input.preface}\n\n${input.prompt}` : input.prompt,
    repos: [{ path: input.cwd, baseRef: null }],
    scenario: { preset: 'chat' },
    // `confirm`, а не `auto`: без `set-cli` ядро взяло бы самый дешёвый маршрут из всех CLI.
    launchPolicy: 'confirm',
    ciWait: false,
    // Продолжение идёт в том же каталоге, что закрытый разговор: его начало человеком и есть
    // грант правки на этот корень — как у формы чата.
    placement: { kind: 'in-place', grant: { project: input.cwd, ops: ['edit'] } },
    ...(input.carry ? { session: input.carry.session } : {}),
  });
  if (!parsed.success) {
    return {
      ok: false,
      code: 'core-foreign-fields',
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  const estimate = await port.estimate(parsed.data, input.carry?.env);
  if (!estimate.ok) return { ok: false, code: estimate.code, message: estimate.message };
  const { taskId } = estimate;
  // Через контур модель — его перевод выбора (шаблон маршрута, s10 G7), усилие контуру не уезжает.
  const contourModel = contourModelOf(input.routes);
  // Выбора нет — `set-model` не нужен: модель маршрута ядро возьмёт само.
  const model = input.model ? (contourModel ?? input.model) : undefined;
  const effort = contourModel ? null : input.effort || null;
  const commands: Array<[Parameters<CoreChatPort['command']>[1], Record<string, unknown>]> = [
    // Маршрут контура — ДО выбора CLI: набор по умолчанию собран из маршрутов входа CLI, а у
    // Goose/OpenCode его нет (`cliLogin: false`), и `set-cli` вне набора ядро отказывает
    // `outside-allowed-set`.
    ...(input.routes?.length
      ? ([['set-route', { scope: 'task', scopeId: taskId, allowedRoutes: input.routes }]] as Array<
          [Parameters<CoreChatPort['command']>[1], Record<string, unknown>]
        >)
      : []),
    ['set-cli', { scope: 'task', scopeId: taskId, adapter: input.cli, timing: 'now' }],
    ...(model
      ? ([
          [
            'set-model',
            {
              scope: 'task',
              scopeId: taskId,
              model,
              effort,
              timing: 'now',
            },
          ],
        ] as Array<[Parameters<CoreChatPort['command']>[1], Record<string, unknown>]>)
      : []),
    ['launch', {}],
  ];
  for (const [kind, fields] of commands) {
    const out = await port.command(taskId, kind, fields);
    if (out.status !== 'applied') {
      // Задача не пойдёт: снимаем её, чтобы в ленте ядра не висела оценка без запуска.
      await port
        .command(taskId, 'cancel', { reason: `server start refused at ${kind}` })
        .catch(() => undefined);
      return {
        ok: false,
        code: out.code ?? 'rejected',
        message: `${kind}: ${out.reason ?? ''}`.trim(),
      };
    }
  }
  return { ok: true, taskId };
}
