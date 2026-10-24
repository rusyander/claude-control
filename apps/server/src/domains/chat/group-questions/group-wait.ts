import type { RunOptions } from '../ChatRunner/ChatRunner.ts';
import type { RunFinished, RunMeta } from '../ChatRunRegistry/ChatRunRegistry.ts';
import { awaitsAnswer } from '../chain-outcome/chain-outcome.ts';
import { humanAsksOf } from '../split-continue.ts';
import type { TreeStartGate } from '../tree-pause/tree-pause.ts';
import { planAnswerFor, type PlanAnswer } from './group-questions.ts';

/**
 * Ход группы «по плану» кончился ОЖИДАНИЕМ ответа, написанным текстом, а не
 * `AskUserQuestion` (живой случай 23.10: группа RBAC закончила ход «Этапы D и E
 * начну после ответа. Вопросы и рекомендации записаны в PROGRESS.md» и стояла
 * 3 ч 41 мин, пока не ответил человек). Брокер прав такой вопрос не видит:
 * вызова нет. Здесь панель отвечает за человека — сразу продолжает ТУ ЖЕ
 * сессию: применить свои рекомендации, сделать самой то, что не требует
 * человека, записать решения в MR и идти дальше.
 *
 * Петля: ход снова кончился ожиданием — второе продолжение называет решения
 * поимённо, взятые из рекомендаций самого агента. Предел `WAIT_RESUME_MAX`
 * подряд — предохранитель от ночи впустую на модели, которая упорно ждёт;
 * после него ход идёт обычным путём. Счёт снимают ход без ожидания и любой
 * старт разговора не от этого модуля (слово человека).
 */

export const WAIT_RESUME_MAX = 3;

// «Ждёт ответа» живёт рядом с `endsWithQuestion` (`chain-outcome.ts`): тем же
// правилом пауза хода читается планировщиком цепочки и итогом группы, и в
// режиме «вопросы — человеку» тоже. Здесь — прежний путь импорта для сторожей.
export { awaitsAnswer };

function prose(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, '').trim();
}

const QUESTION_ITEM = /^\s{0,1}(\d+)[.)]\s+(.+)$/;
const OPTION_ITEM = /^\s*[-*•]\s+(.+)$/;
const DECISIONS_MAX = 10;
const LABEL_MAX = 200;

function clean(line: string): string {
  const flat = line
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/:$/, '');
  return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX - 1)}…` : flat;
}

/**
 * Решения из рекомендаций самого агента: нумерованный пункт — вопрос, его
 * пункты списка — варианты; выбор тем же правилом, что у вопроса инструментом
 * (`planAnswerFor`: помеченный рекомендацией, без метки — первый, не зовущий
 * человека). Пункт без вариантов — не вопрос, а шаг отчёта.
 */
export function ownDecisions(text: string): PlanAnswer[] {
  const questions: { question: string; options: { label: string }[] }[] = [];
  let current: (typeof questions)[number] | undefined;
  for (const line of prose(text).split('\n')) {
    const question = QUESTION_ITEM.exec(line);
    if (question) {
      current = { question: clean(question[2] ?? ''), options: [] };
      questions.push(current);
      continue;
    }
    const option = OPTION_ITEM.exec(line);
    if (option && current) {
      current.options.push({ label: clean(option[1] ?? '') });
      continue;
    }
    // Пустая строка или абзац без отступа закрывает вопрос: дальше — отчёт.
    if (current && line.trim() && !/^\s/.test(line)) current = undefined;
  }
  return questions
    .filter((entry) => entry.options.length > 0)
    .slice(0, DECISIONS_MAX)
    .map((entry) => planAnswerFor(entry));
}

const HEAD =
  '[Autonomous mode] The human does not answer this split group — the panel answers for them.';

/** Первое продолжение: применить свои рекомендации ко всем открытым вопросам. */
export function waitResumePrompt(decisions: readonly PlanAnswer[], attempt: number): string {
  const tail =
    'Do yourself what needs no human; a step only a human can take is skipped and named as a gap ' +
    'in the MR description. Record each decision and its reason in the MR description, then ' +
    'continue the task from where you stopped, the remaining stages included. Never end a turn ' +
    'waiting for an answer again.';
  if (attempt <= 1) {
    return (
      `${HEAD} Apply your own recommendations to every open question you listed (the option you ` +
      `marked recommended, otherwise the first one you listed). ${tail}`
    );
  }
  const spelled =
    decisions.length > 0
      ? [
          'These are the decisions, taken from your own recommendations — apply them now:',
          ...decisions.map(
            (decision, index) =>
              `${index + 1}. ${JSON.stringify(decision.question)} → ${JSON.stringify(decision.label)}`,
          ),
        ].join('\n')
      : 'For every open question take the option you recommended, otherwise the first one you listed — ' +
        'that is the decision; do not ask about it again.';
  return `${HEAD} Your turn ended waiting for an answer again; no answer will come.\n${spelled}\n${tail}`;
}

/** Ответ без разобранных решений — одна отметка «решить по плану самой». */
const OWN_PLAN: PlanAnswer = {
  question: '',
  label: 'apply own recommendations and continue',
  critical: false,
  free: true,
};

export interface GroupWaitDeps {
  /** Группа разделения под «по плану» с автономией (та же проверка, что у брокера). */
  groupOf: (keys: readonly string[]) => { parentChatId: string; groupIndex: number } | undefined;
  /** Завести ход; `false` — реестр отказал (разговор уже идёт). */
  start: (chatId: string, options: RunOptions, meta: RunMeta) => boolean;
  /** Мост прав нового хода — к этой панели под ключом запуска. */
  bridge?: (runId: string) => RunOptions['permissionPrompt'];
  /**
   * Воротца «Остановить всё» (F-44): дерево стоит — продолжение ложится в его
   * очередь, как шаг конвейера (`handoff-routes.ts`), а не стартует поверх паузы.
   */
  gate?: Pick<TreeStartGate, 'defer'>;
  /**
   * Реестр отказал в старте (F-44): `finished` уже сказал «продолжила», и
   * планировщик этот конец пропустил — без отката группа молчала бы до сторожа.
   * Вызывающий проводит конец хода обычным путём.
   */
  refused?: (finished: RunFinished) => void;
  /** Отметка «ответ дан автоматически» в хаб родителя. */
  notice: (group: { parentChatId: string; groupIndex: number }, answers: PlanAnswer[]) => void;
  /**
   * Счёт продолжений подряд по разговору (F-87). Сборка держит его в
   * `state.json`: в памяти перезапуск панели (каждый git pull, сторож) обнулял
   * его, и упорно ждущая модель получала новые `WAIT_RESUME_MAX` продолжений.
   * Без него — счёт в памяти (юниты).
   */
  counter?: WaitResumeCounter;
  schedule?: (run: () => void) => void;
  log: (message: string, detail?: unknown) => void;
}

export interface WaitResumeCounter {
  get: (conversation: string) => number;
  set: (
    conversation: string,
    count: number,
    group: { parentChatId: string; groupIndex: number },
  ) => void;
  delete: (conversation: string) => void;
}

function memoryCounter(): WaitResumeCounter {
  const spent = new Map<string, number>();
  return {
    get: (conversation) => spent.get(conversation) ?? 0,
    set: (conversation, count) => {
      if (count > 0) spent.set(conversation, count);
      else spent.delete(conversation);
    },
    delete: (conversation) => spent.delete(conversation),
  };
}

export class GroupWaitResume {
  private readonly deps: GroupWaitDeps;
  /** Продолжения подряд по разговору (ключ — номер сессии). */
  private readonly spent: WaitResumeCounter;
  /** Разговоры, чей старт сейчас наш: слушатель стартов не должен принять его за слово человека. */
  private readonly own = new Set<string>();

  constructor(deps: GroupWaitDeps) {
    this.deps = deps;
    this.spent = deps.counter ?? memoryCounter();
  }

  /** Ход кончился. `true` — панель продолжила разговор сама; планировщик стадий этот конец пропускает. */
  finished(finished: RunFinished): boolean {
    if (!finished.ok || finished.interrupted || finished.background || !finished.sessionId) {
      return false;
    }
    const keys = [finished.chatId, finished.sessionId];
    const group = this.deps.groupOf(keys);
    if (!group) return false;
    const conversation = finished.sessionId;
    // Метка `HUMAN:` — то, что можно только человеку (`HUMAN_ONLY_LINE`, F-67):
    // ответ панели за него обошёл бы стоп конвейера до трёх раз подряд.
    // Полный текст, не хвост: хвост обрезан до 280 знаков спереди и терял метку.
    if (humanAsksOf(finished.text).length > 0) {
      this.spent.delete(conversation);
      return false;
    }
    if (!finished.asked && !awaitsAnswer(finished.text)) {
      this.spent.delete(conversation);
      return false;
    }
    const attempt = this.spent.get(conversation) + 1;
    if (attempt > WAIT_RESUME_MAX) {
      this.deps.log('group wait: resume limit reached', conversation);
      return false;
    }
    this.spent.set(conversation, attempt, group);

    const decisions = ownDecisions(finished.text);
    const key = keys.find((alias) => !alias.startsWith('new-')) ?? conversation;
    const options: RunOptions = {
      ...finished.options,
      prompt: waitResumePrompt(decisions, attempt),
      sessionId: conversation,
      fork: false,
    };
    delete options.name;
    const bridge = this.deps.bridge?.(key);
    if (bridge) options.permissionPrompt = bridge;
    else if (options.permissionPrompt) {
      options.permissionPrompt = { ...options.permissionPrompt, runId: key };
    }
    const meta: RunMeta = {
      sessionId: conversation,
      ...(finished.origin ? { origin: finished.origin } : {}),
      ...(finished.projectPath ? { projectPath: finished.projectPath } : {}),
    };
    try {
      this.deps.notice(group, decisions.length > 0 ? decisions : [OWN_PLAN]);
    } catch (error) {
      // Отметка — для хаба: отказ диска не оставляет группу ждать.
      this.deps.log('group wait: hub notice not recorded', error);
    }
    // Старт — после того, как закончившийся прогон закроет своих слушателей
    // (тот же порядок, что у звена конвейера в `handoff-routes.ts`).
    const refuse = (): void => {
      this.own.delete(conversation);
      // Возврат попытки — только если счёт всё ещё наш: старт, отложенный паузой
      // дерева, выходит из очереди спустя часы, и за это время слово человека
      // могло обнулить счёт — вернуть ему «attempt − 1» значило бы воскресить его.
      if (this.spent.get(conversation) === attempt) {
        this.spent.set(conversation, attempt - 1, group);
      }
      this.deps.log('group wait: resume start refused', key);
      try {
        this.deps.refused?.(finished);
      } catch (error) {
        this.deps.log('group wait: fallback after refusal failed', error);
      }
    };
    (this.deps.schedule ?? ((run) => setTimeout(run, 0)))(() => {
      // Отложенный паузой дерева старт — тоже наш (RF-EF-05): «Продолжить всё»
      // выпустит его с той же пометкой и тем же отказом, что и старт здесь.
      const deferred = this.deps.gate?.defer('handoff', key, options, meta, {
        before: () => this.own.add(conversation),
        after: (started) => {
          if (!started) refuse();
        },
      });
      if (deferred) return;
      this.own.add(conversation);
      if (!this.deps.start(key, options, meta)) refuse();
    });
    return true;
  }

  /** Старт разговора: наш — счёт не трогаем; любой другой (слово человека) — счёт заново. */
  started(keys: readonly string[]): void {
    const own = keys.find((key) => this.own.has(key));
    if (own !== undefined) {
      this.own.delete(own);
      return;
    }
    for (const key of keys) this.spent.delete(key);
  }
}
