import { parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import {
  ASSIGNABLE_EFFORTS,
  ceilingEffortRank,
  ceilingModelRank,
  deliverStagePrompt,
} from '@agentdeck/contracts/model-cascade';
import { OWNER_PRECEDENCE_LINE } from '@agentdeck/contracts/quality-floor';
import type {
  ChatLink,
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../../lib/app-store/app-store.types.ts';
import { carriedStageLink, conversationKeys } from '../../../lib/app-store/chat-links.ts';
import type { FreshDeliveryMode } from '../split-conveyor/split-conveyor.ts';

/**
 * Новый разговор группы стадией ДОСТАВКИ — по слову конвейера, а не по концу
 * хода (решение владельца 23.10: пробелы доставки доводят агенты, не человек).
 *
 * Зачем новый, а не продолжение: напоминание продолжает сессию, в которой
 * группа сейчас, а у ревью и плана MCP хранилища кода только на чтение и пуш
 * закрыт звеном доставки впереди. Живая группа 23.10 получила четыре «откройте
 * MR» в сессию ревью без `create_merge_request` и встала. Стадия `deliver` в
 * связи даёт профиль доставки: пуш и запись в MR разрешены, слияние — нет.
 *
 * Разбор (`escalate`) — тот же новый разговор доставки, но на усиленной модели
 * и глубине: напоминания встали или кончились, и тот же агент тем же способом
 * их не сдвинет.
 *
 * Связь без настоящей сессии, отказ старта — `refused`: конвейер тогда идёт
 * прежним путём (напоминание или сдача с причиной). Разговор группы занят —
 * `busy`, а не `refused`: отказ на миг чужого хода ронял группу «встала» с
 * разбором, который так и не ушёл (трасса автономии 24.10, §2.2); конвейер
 * сверяет снова после хода. Чужой CLI — тот же новый разговор его хранилищем
 * (`startForeignReviewStage`): напоминания в его сессию ревью или плана шли
 * впустую до потолка (§2.3).
 */

type Delivery = 'sent' | 'queued' | 'refused' | 'busy';

/** Старт разговора стадии — тот же, что у звеньев ревью (`createReviewStarter`). */
export type DeliverStageStart = (input: {
  chatId: string;
  prompt: string;
  cwd: string;
  model?: string;
  effort?: string;
  stage: 'push';
  fromAliases: string[];
  title?: string;
}) => { started: boolean; busy?: boolean; chatId?: string };

export interface DeliverStageDeps {
  links: () => Record<string, ChatLink>;
  setLink: (chatId: string, link: ChatLink) => void;
  removeLink: (chatId: string) => void;
  /** Идёт ли прогон под ключом (и чужого CLI тоже): второй агент в той же копии — нельзя. */
  running: (chatId: string) => boolean;
  start: DeliverStageStart;
  /**
   * Связь перенесена на настоящий ключ чужого разговора (его выдаёт хранилище
   * провайдера уже в старте). Слушатель старта чужого CLI связь под этим ключом
   * ещё не видел, и группа без этого осталась бы «проверяю доставку», пока
   * идёт её новый разговор, — сверка напомнила бы ей поверх хода.
   */
  resumed?: (chatId: string, link: ChatLink) => void;
  /** Потолок панели (модель и глубина чата по умолчанию) — верх разбора, когда у звена своего нет. */
  ceiling: () => { model?: string; effort?: string };
  now?: () => number;
  log: (message: string, error?: unknown) => void;
}

/**
 * Глубина на ступень выше, не выше потолка и никогда не `max` — но и не ниже
 * той, на которой группа уже шла (F-42: потолок панели `medium` опускал xhigh).
 */
function strongerEffort(current: string | undefined, ceiling: string | undefined): string {
  const top = Math.min(ceilingEffortRank(ceiling ?? ''), ASSIGNABLE_EFFORTS.length);
  const own = current ? Math.min(ceilingEffortRank(current), ASSIGNABLE_EFFORTS.length) : 0;
  const from = Math.max(own, 2);
  const rank = Math.max(Math.min(from + 1, top), own);
  return ASSIGNABLE_EFFORTS[rank - 1] ?? 'high';
}

/**
 * Модель и глубина нового разговора. Доставка — на модели работы, как звено
 * доставки планировщика (`deliverPlan`). Разбор — самая сильная из известных
 * группе и потолка, глубина на ступень выше. Потолок — звена, когда он задан
 * (F-42), иначе панели; ниже модели и глубины самой группы разбор не опускается.
 */
export function deliverStageChoice(
  link: Pick<
    ChatLink,
    'model' | 'effort' | 'workModel' | 'workEffort' | 'ceilingModel' | 'ceilingEffort'
  >,
  mode: FreshDeliveryMode,
  panel: { model?: string; effort?: string },
): { model?: string; effort?: string } {
  const model = link.workModel ?? link.model;
  const effort = link.workEffort ?? link.effort;
  if (mode === 'deliver') {
    return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }
  const ceiling = {
    model: link.ceilingModel ?? panel.model,
    effort: link.ceilingEffort ?? panel.effort,
  };
  const candidates = [ceiling.model, link.model, link.workModel].filter((value): value is string =>
    Boolean(value),
  );
  let strongest: string | undefined;
  let best = 0;
  for (const value of candidates) {
    const rank = ceilingModelRank(value) ?? 0;
    if (rank > best) {
      best = rank;
      strongest = value;
    }
  }
  const chosen = strongest ?? model;
  // Ступень выше самой глубокой, на которой группа уже шла (работа или ревью).
  const deepest = [link.effort, link.workEffort]
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => ceilingEffortRank(b) - ceilingEffortRank(a))[0];
  return {
    ...(chosen ? { model: chosen } : {}),
    effort: strongerEffort(deepest, ceiling.effort),
  };
}

/** Вводная нового разговора доставки: откуда он, что о группе знать. */
export function deliverFreshBrief(input: {
  previous: string;
  group: Pick<SplitPlanGroupRecord, 'title' | 'branch' | 'path' | 'mr'>;
  task?: string;
  tasks: readonly string[];
  mode: FreshDeliveryMode;
}): string {
  const { group } = input;
  const why =
    input.mode === 'escalate'
      ? 'the panel escalated the delivery to a fresh diagnose-and-fix run'
      : 'the previous session could not deliver (no push, no MR tools in its stage)';
  const lines = [
    `This is a NEW delivery conversation of the split group «${group.title}»: ${why}. The ` +
      `previous conversation (${input.previous}) stays in the chat history — do not resume it.`,
    `Branch ${group.branch}, working copy ${group.path ?? '—'}, MR ${group.mr ?? '—'}.`,
    'Restore the context from the facts: git status, git log of the branch, the MR, ' +
      '.agent/PROGRESS.md in the copy if present.',
  ];
  const task = input.task?.trim();
  if (task) lines.push('', "The group's task, as it was given:", task);
  else if (input.tasks.length > 0) {
    lines.push('', "The group's tasks:", ...input.tasks.map((item) => `- ${item}`));
  }
  lines.push('', OWNER_PRECEDENCE_LINE);
  return lines.join('\n');
}

export function createDeliverStageSession(
  deps: DeliverStageDeps,
): (
  record: SplitPlanRecord,
  group: SplitPlanGroupRecord,
  prompt: string,
  mode: FreshDeliveryMode,
) => Delivery {
  return (record, group, prompt, mode) => {
    const chatId = group.chatId;
    const link = chatId ? deps.links()[chatId] : undefined;
    if (!chatId || !group.path || !link) return 'refused';
    const aliases = [...new Set([chatId, ...conversationKeys(deps.links(), chatId)])];
    const previous = aliases.find((key) => !key.startsWith('new-'));
    if (!previous) return 'refused';
    if (aliases.some((key) => deps.running(key))) return 'busy';
    const foreign = aliases.some((key) => parseForeignChatKey(key));
    const at = (deps.now ?? Date.now)();
    const key = `new-${at}-deliver${group.index}`;
    // Потолок панели — модель Claude: чужой CLI запустился бы с ней и упал (RC-D-03).
    // Разбор у чужого CLI — его настройкой, без флагов, как ревью и проверка
    // (`planForeignStage`): это и есть единственное «выше», которое у него есть.
    const choice: { model?: string; effort?: string } =
      foreign && mode === 'escalate' ? {} : deliverStageChoice(link, mode, deps.ceiling());
    const brief = deliverFreshBrief({
      previous,
      group,
      ...(link.groupTask ? { task: link.groupTask } : {}),
      tasks: record.proposal.groups[group.index]?.tasks ?? [],
      mode,
    });
    const task = [
      brief,
      // У чужого CLI инструмента вопросов нет (F8): вопрос — последней строкой ответа.
      deliverStagePrompt({
        after: 'review',
        branch: group.branch,
        ...(foreign ? { foreign } : {}),
      }),
      prompt,
    ].join('\n\n');
    // Стадия доставки в связи — профиль доставки (пуш, запись в MR); модель —
    // в связь тоже, иначе следующий ход того же разговора вернулся бы к старой.
    // Окно работы — своё, с этого разговора (F-110), а не звена, у которого
    // доставку забрали.
    deps.setLink(key, {
      ...carriedStageLink(link),
      stage: 'deliver',
      conversation: key,
      createdAt: new Date(at).toISOString(),
      ...(choice.model ? { model: choice.model } : {}),
      ...(choice.effort ? { effort: choice.effort } : {}),
      stagePrompt: task,
    });
    let outcome: { started: boolean; busy?: boolean; chatId?: string } = { started: false };
    try {
      outcome = deps.start({
        chatId: key,
        prompt: task,
        cwd: group.path,
        ...(choice.model ? { model: choice.model } : {}),
        ...(choice.effort ? { effort: choice.effort } : {}),
        stage: 'push',
        fromAliases: aliases,
        ...(link.title ? { title: link.title } : {}),
      });
    } catch (error) {
      deps.log('split delivery: fresh stage start failed', error);
    }
    if (outcome.started) {
      const real = outcome.chatId;
      if (foreign && real && real !== key) {
        // Ключ чужого разговора выдало хранилище провайдера: связь — на него,
        // временная не висит строкой хаба без разговора.
        const moved = deps.links()[key];
        if (moved) {
          deps.setLink(real, { ...moved, conversation: real });
          deps.removeLink(key);
          // Отложенный паузой дерева старт ещё не идёт: «Продолжить всё» сам
          // позовёт слушатель старта, и связь под ключом он уже найдёт.
          if (deps.running(real)) deps.resumed?.(real, { ...moved, conversation: real });
        }
      }
      return 'sent';
    }
    deps.removeLink(key);
    deps.log(`split delivery: fresh ${mode} stage refused (${record.parentChatId}#${group.index})`);
    return outcome.busy ? 'busy' : 'refused';
  };
}
