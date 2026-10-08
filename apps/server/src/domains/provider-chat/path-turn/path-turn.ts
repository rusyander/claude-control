import type { PathStep } from '@agentdeck/contracts/group-path';
import type { CascadeStage } from '@agentdeck/contracts/model-cascade';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import { stageOf } from '../../chat/ChatCascadeStages/ChatCascadeStages.ts';
import { chainOutcomeOf, type ChainOutcomeInput } from '../../chat/chain-outcome/chain-outcome.ts';
import { planPathTurn } from '../../chat/path-steps/path-steps.ts';
import type { ChainOutcome } from '../../chat/split-conveyor/split-conveyor.ts';

/**
 * Свои шаги «Пути» группы после стадии — у звена ЧУЖОГО CLI.
 *
 * Решение то же, что у Claude (`planPathTurn`): шаг идёт отдельным ходом ТОГО
 * ЖЕ разговора, ответ стадии на это время откладывается, проверка шага без
 * блока «прошла» не считается. Раньше каскад чужого CLI шагов не знал вовсе:
 * группа с «Путём», выбранная звену Qwen или Codex, проходила стадии без них,
 * и ни человек, ни хаб об этом не узнавали.
 */

export interface ForeignPathTurnInput {
  chatKey: string;
  link: ChatLink;
  cwd: string;
  ok: boolean;
  paused: boolean;
  text: string;
  task: string;
  error?: string;
  retry?: ChainOutcomeInput['retry'];
}

export interface ForeignPathTurnDeps {
  /** Шаги группы разговора после стадии (`runPathSteps`). */
  pathSteps: (aliases: string[], stage: CascadeStage, cwd: string) => PathStep[];
  saveLink?: (chatKey: string, link: ChatLink) => void;
  onChainEnded?: (link: ChatLink, outcome: ChainOutcome) => void;
  /** Ход шага в том же разговоре; `false` — не запустился (разговор занят). */
  sendStep: (prompt: string) => boolean;
}

/**
 * `stop` — конвейер дальше не идёт (заведён шаг, шаг ждёт, проверка не
 * закрыта); `notice` — строка в ленту разговора. Иначе конвейер продолжается
 * ответом СТАДИИ (`text`, `task`), отложенным на время шагов.
 */
export type ForeignPathOutcome =
  { stop: true; notice?: string } | { stop: false; text: string; task: string };

const stepName = (step: PathStep): string => step.title.ru.trim() || step.title.en.trim() || '—';

export function foreignPathTurn(
  input: ForeignPathTurnInput,
  deps: ForeignPathTurnDeps,
): ForeignPathOutcome {
  const { chatKey, link } = input;
  const stage = stageOf(link);
  const steps = deps.pathSteps([chatKey], stage, input.cwd);
  if (steps.length === 0 && !link.pathRun) {
    return { stop: false, text: input.text, task: input.task };
  }

  const decision = planPathTurn({
    link,
    stage,
    steps,
    ok: input.ok,
    paused: input.paused,
    text: input.text,
    task: input.task,
  });

  if (decision.kind === 'wait') {
    // Шаг кончился сбоем или вопросом: он остаётся незакрытым, но группа
    // разделения итог узнать обязана — иначе висит «в работе» (как у Claude).
    if (link.parentChatId) {
      deps.onChainEnded?.(
        link,
        chainOutcomeOf({
          link,
          ok: input.ok,
          text: input.text,
          ...(input.paused ? { asked: true } : {}),
          ...(input.error ? { error: input.error } : {}),
          ...(input.retry ? { retry: input.retry } : {}),
        }),
      );
    }
    return { stop: true };
  }
  if (decision.kind === 'gate-failed') {
    const notice = serverText('path-gate-failed-notice', {
      step: stepName(decision.step),
      note: decision.note || '—',
    });
    if (link.parentChatId) {
      deps.onChainEnded?.(link, { status: 'awaiting', waitingFor: 'question', tail: notice });
    }
    return { stop: true, notice };
  }
  if (decision.kind === 'continue') {
    if (decision.link) deps.saveLink?.(chatKey, decision.link);
    return { stop: false, text: decision.text, task: decision.task };
  }

  // Отметка — ДО запуска: второй конец хода не заведёт тот же шаг снова.
  deps.saveLink?.(chatKey, decision.link);
  if (!deps.sendStep(decision.prompt)) {
    // Не стартовал — шаг не пропадает молча: отметка снята, следующий конец
    // хода в этом разговоре заведёт его снова.
    deps.saveLink?.(chatKey, link);
    return { stop: true };
  }
  return {
    stop: true,
    notice: serverText('path-step-started-notice', { step: stepName(decision.step) }),
  };
}
