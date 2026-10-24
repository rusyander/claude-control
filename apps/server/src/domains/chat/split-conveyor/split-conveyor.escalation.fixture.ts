import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import type { ChatLink, SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import type { RunFinished } from '../ChatRunRegistry/ChatRunRegistry.ts';
import { missingDelivery } from '../../project-git/delivery-facts/delivery-facts.ts';
import { chainOutcomeOf } from '../chain-outcome/chain-outcome.ts';
import {
  SplitConveyor,
  type DeliveryVerdict,
  type FreshDeliveryMode,
  type SplitDeliveryDeps,
} from './split-conveyor.ts';

/**
 * Конвейер одной группы с доставкой — для тестов кругов доставки. Сверка git —
 * очередь ответов `answers`, слова группе копятся в `words`, новый разговор
 * доставки, как настоящий старт, переводит группу на чат `new-<mode>` изнутри слова.
 */

export const PROPOSAL = {
  shared: '',
  groups: [{ title: 'Пользователи', branch: 'feature/users', tasks: ['списки и сброс пароля'] }],
};
// Настоящая строка пробела, с кодом: по нему промпт узнаёт «нет MR».
export const [NO_MR = ''] = missingDelivery({ dirty: [], pushed: true }, 'feature/users');

function triageDone(): RunFinished {
  return {
    chatId: 'triage',
    projectPath: 'C:/repo',
    text: 'Ничего не нашёл.',
    ok: true,
    startedAt: 1,
    options: { prompt: '', cwd: 'C:/repo' },
    contextTokens: 0,
  };
}

export interface Word {
  via: 'nudge' | FreshDeliveryMode;
  prompt: string;
  /** Напоминание: звено доставки ещё впереди — ходу закрыты пуш и MR (`aheadDeny`). */
  deliverAhead?: boolean;
}

export function harness(
  answers: DeliveryVerdict[],
  options: {
    stage?: string;
    nudge?: 'sent' | 'refused' | 'queued';
    /** Ответ нового разговора; список — по ответу на старт, последний повторяется. */
    fresh?: 'sent' | 'refused' | 'none' | ('sent' | 'refused' | 'busy')[];
    /** «Продолжить» группу кнопкой (`continueGroup`); нет — продолжать нечем. */
    resume?: 'sent' | 'queued';
  } = {},
) {
  // Стадия разговора группы: новый разговор доставки — `deliver`, прочие — эта.
  const stageOfChat = { value: options.stage ?? 'work' };
  const records = new Map<string, SplitPlanRecord>();
  const words: Word[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const freshQueue = Array.isArray(options.fresh) ? [...options.fresh] : undefined;
  const nextFresh = (): 'sent' | 'refused' | 'busy' => {
    if (!freshQueue) return options.fresh === 'refused' ? 'refused' : 'sent';
    return (freshQueue.length > 1 ? freshQueue.shift() : freshQueue[0]) ?? 'sent';
  };
  let tick = 0;
  // Ссылка на конвейер нужна колбэку старта: он, как настоящий запуск, зовёт
  // `onChainResumed` ИЗНУТРИ слова и переводит группу на новый разговор.
  const ref: { conveyor?: SplitConveyor } = {};
  const link: ChatLink = {
    parentChatId: 'родитель',
    createdAt: '',
    branch: 'feature/users',
    stage: 'work',
  };
  const delivery: SplitDeliveryDeps = {
    facts: async () => answers.shift() ?? { missing: [] },
    nudge: (_group, prompt) => {
      // Профиль хода напоминания собирается из хранилища (`deliverAhead`) — его и помним.
      words.push({ via: 'nudge', prompt, deliverAhead: ref.conveyor?.deliverAhead(link) ?? false });
      return options.nudge ?? 'sent';
    },
    schedule: (run, ms) => void timers.push({ run, ms }),
    stage: (group) =>
      /^new-(deliver|escalate)/.test(group.chatId ?? '') ? 'deliver' : stageOfChat.value,
    ...(options.fresh === 'none'
      ? {}
      : {
          freshStage: (_record, _group, prompt, mode) => {
            const answer = nextFresh();
            // Занят — старта нет, как у настоящего `createDeliverStageSession`.
            if (answer === 'busy') return 'busy';
            words.push({ via: mode, prompt });
            if (answer === 'refused') return 'refused';
            ref.conveyor?.onChainResumed({ ...link, stage: 'deliver' }, `new-${mode}`);
            return 'sent';
          },
        }),
  };
  const conveyor = new SplitConveyor({
    store: {
      get: (parent) => records.get(parent),
      set: (record) => void records.set(record.parentChatId, structuredClone(record)),
      findByTriage: (ids) =>
        [...records.values()].find((record) => ids.includes(record.triageChatId ?? '')),
      all: () => Object.fromEntries(records),
    },
    launch: async (record, groups): Promise<TaskSplitResult> => ({
      chats: groups.map((index) => ({
        index,
        title: record.proposal.groups[index]?.title ?? '',
        branch: record.groups[index]?.branch ?? '',
        chatId: `new-${index}`,
        path: `C:/copies/${index}`,
        isWorktree: true,
        started: true,
        prompt: '',
        deliver: true,
      })),
      failures: [],
    }),
    startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
    watchOverlap: () => undefined,
    delivery,
    ...(options.resume ? { resume: () => options.resume ?? 'refused' } : {}),
    log: () => undefined,
    now: () => new Date(2026, 9, 23, 12, 0, (tick += 1)),
  });
  ref.conveyor = conveyor;
  const settle = () => new Promise((done) => setTimeout(done, 5));
  const start = async () => {
    await conveyor.begin({
      parentChatId: 'родитель',
      projectPath: 'C:/repo',
      proposal: PROPOSAL,
      request: {},
    });
    conveyor.onTriageFinished(triageDone(), ['triage']);
    await settle();
  };
  /**
   * Цепочка кончилась, сверка и повторная сверка (пауза на ссылку MR). Текст
   * ответа идёт через настоящий `chainOutcomeOf` — итог читается так же, как у
   * живого хода (хвост ≤280 знаков, метки `HUMAN:` — из полного текста).
   */
  const round = async (text?: string) => {
    conveyor.onChainEnded(
      link,
      text ? chainOutcomeOf({ link, ok: true, text }) : { status: 'done' },
    );
    await settle();
    timers.shift()?.run();
    await settle();
  };
  const group = () => records.get('родитель')?.groups[0];
  /** Следующий отложенный шаг (повтор панели, повторная сверка) и осесть. */
  const fire = async () => {
    timers.shift()?.run();
    await settle();
  };
  return { conveyor, start, round, fire, timers, group, words, stageOfChat, records };
}
