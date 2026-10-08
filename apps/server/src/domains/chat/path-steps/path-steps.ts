import { blockLang } from '@agentdeck/contracts/brand';
import {
  ANSWER_LANGUAGE_LINE,
  ESCALATE_LINE,
  type CascadeStage,
} from '@agentdeck/contracts/model-cascade';
import type { GroupFlow } from '@agentdeck/contracts';
import type { PathStep } from '@agentdeck/contracts/group-path';
import { groupKeyOf, type GroupScope } from '@agentdeck/contracts/group-sources';
import type { ChatLink, PathRun } from '../../../lib/app-store/app-store.types.ts';
import { readJsonBlock } from '../../groups/answer-block.ts';
import { buildPath } from '../../groups/path/path.ts';

/**
 * Свои шаги «Пути» группы в конвейере: после встроенной стадии идут шаги
 * человека, привязанные к ней, — ходами в ТОМ ЖЕ чате стадии, продолжением его
 * сессии. Отдельный чат на шаг потерял бы то, ради чего шаг ставят после
 * стадии: её контекст (что спланировано, что сделано, что найдено ревью).
 *
 * Модуль ЧИСТЫЙ, как и `ChatCascadeStages.ts`: отвечает, что делать с концом
 * хода, а запуск и запись связи делает планировщик (`handoff-routes.ts`).
 *
 * Три вещи, которые легко потерять при правке:
 *
 * 1. ШАГ ЗАВОДИТСЯ ОДИН РАЗ на чат (`pathRun.done`). Иначе каждый ход человека в
 *    законченный чат стадии заводил бы шаги заново.
 * 2. ОТВЕТ СТАДИИ ОТКЛАДЫВАЕТСЯ (`pathRun.held`). Следующее звено решается по
 *    ответу стадии — блоку плана, вердикту ревью; ответ шага их не несёт, и без
 *    отложенного текста ревью с замечаниями кончалось бы ничем.
 * 3. ПРОВАЛ ПРОВЕРКИ ОСТАНАВЛИВАЕТ ЦЕПОЧКУ. Шаг с проверкой, не закрытый моделью,
 *    — это вопрос человеку, а не повод идти в ревью или доставку.
 */

export const GATE_BLOCK_KIND = 'gate';

/** Знаков отложенного ответа стадии: хвост, где лежат блоки, а не весь ответ. */
const HELD_TEXT_MAX = 24_000;
/** Столько же, сколько хранит связь для задания группы. */
const HELD_TASK_MAX = 16_000;

/** Итог проверки шага из блока ответа. */
export interface PathGate {
  passed: boolean;
  note: string;
}

/** Последний закрытый блок проверки; нет блока или он без `passed` — `undefined`. */
export function scanGateBlock(text: string): PathGate | undefined {
  const raw = readJsonBlock(text, GATE_BLOCK_KIND);
  if (!raw || typeof raw !== 'object') return undefined;
  const { passed, note } = raw as { passed?: unknown; note?: unknown };
  if (typeof passed !== 'boolean') return undefined;
  return { passed, note: typeof note === 'string' ? note.trim() : '' };
}

/** Английская сторона, а пустая — русская: непереведённый шаг лучше пропущенного. */
function enOf(text: { ru: string; en: string } | undefined): string {
  return (text?.en.trim() || text?.ru.trim()) ?? '';
}

function resourceLine(step: PathStep): string | undefined {
  if (step.kind !== 'resource' || !step.resource) return undefined;
  const { type, id } = step.resource;
  if (type === 'skill') return `Apply the skill \`${id}\` for this step.`;
  // Утилита сама не действует, как хук или правило: её надо запустить.
  if (type === 'script') {
    return (
      `Run the utility script \`${id}\` for this step — it lives in the hooks folder of the ` +
      'Claude config directory; run it with the interpreter its extension implies and use its output.'
    );
  }
  return `The ${type} \`${id}\` is active for this step; follow it.`;
}

/** Сколько символов строки человека цитируется как образец его языка. */
const LANGUAGE_SAMPLE_MAX = 160;

/**
 * Строка о языке ответа хода шага. Задание шага — английское (`prompt.en`),
 * и общая строка «на языке задания» сама по себе вела бы к английскому отчёту
 * русскому владельцу: заданием этого хода был английский шаг. Поэтому модели
 * показывается строка человека из задания стадии: инструкции панели только
 * английские, значит строка с буквами не латиницы — его. Такой строки нет —
 * человек, видимо, пишет по-английски, и хватает общей строки.
 */
export function stepAnswerLanguageLine(task: string): string {
  const human = task
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /[^\p{Script=Latin}\P{L}]/u.test(line))
    .sort((a, b) => b.length - a.length)[0];
  if (!human) return ANSWER_LANGUAGE_LINE;
  return (
    'Write your answer in the language the human uses in this task, not in the language of this ' +
    `step or of these instructions. The human wrote, for example: "${human.slice(0, LANGUAGE_SAMPLE_MAX)}"`
  );
}

/**
 * Задание хода шага. Модели — по-английски (`prompt.en`), ответ человеку — на
 * языке человека из задания стадии (`task`, см. `stepAnswerLanguageLine`);
 * проверка просит блок, иначе конец хода нечем сверить.
 */
export function pathStepPrompt(step: PathStep, anchor: CascadeStage, task = ''): string {
  const title = enOf(step.title);
  const gate = enOf(step.gate);
  return [
    `Next step of this task's path, after the ${anchor} stage${title ? `: ${title}` : ''}.`,
    enOf(step.prompt),
    resourceLine(step),
    gate
      ? [
          `This step is closed only when: ${gate}`,
          'Check it yourself. If it fails and you can fix it, fix it and check again. End your ' +
            `answer with a code block in the language ${blockLang(GATE_BLOCK_KIND)} with JSON ` +
            '{"passed": true or false, "note": "one line: what you checked, or what is still ' +
            'missing"}. Report passed false only when you cannot close it without the owner.',
        ].join('\n')
      : undefined,
    stepAnswerLanguageLine(task),
    ESCALATE_LINE,
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join('\n\n');
}

export interface PathTurnInput {
  link: ChatLink;
  stage: CascadeStage;
  /** Свои шаги группы чата, привязанные к `stage`, в порядке пути. */
  steps: readonly PathStep[];
  ok: boolean;
  /** Ход кончился вопросом или ждёт фон (Д3). */
  paused: boolean;
  text: string;
  /** Задание закончившегося хода. */
  task: string;
}

export type PathDecision =
  /** Завести ход шага; `link` — связь с отметками, записать ДО запуска. */
  | { kind: 'step'; step: PathStep; prompt: string; link: ChatLink }
  /** Проверка шага не закрыта: цепочка ждёт человека. */
  | { kind: 'gate-failed'; step: PathStep; note: string }
  /** Ход шага не кончился итогом (сбой, вопрос, фон) — ничего не заводим. */
  | { kind: 'wait' }
  /**
   * Шагов больше нет: конвейер идёт дальше по ответу СТАДИИ. `link` — только
   * когда отметки изменились и их надо записать.
   */
  | { kind: 'continue'; text: string; task: string; link?: ChatLink };

function withRun(link: ChatLink, run: PathRun | undefined): ChatLink {
  const next = { ...link };
  if (run) next.pathRun = run;
  else delete next.pathRun;
  return next;
}

/** Что делать с концом хода в чате стадии, у группы которого есть свои шаги. */
export function planPathTurn(input: PathTurnInput): PathDecision {
  const { link, stage, steps } = input;
  const run = link.pathRun;
  let done = run?.done ?? [];

  if (run?.pending) {
    // Ход шага кончился сбоем или паузой — ни следующего шага, ни звена: ответ
    // человека в этот чат доведёт шаг, и его конец сверится снова.
    if (!input.ok || input.paused) return { kind: 'wait' };
    const step = steps.find((item) => item.id === run.pending);
    // Шаг с проверкой обязан отчитаться блоком. Нет блока — не «прошёл»:
    // иначе забытый блок молча пропускал бы проверку.
    if (step && enOf(step.gate)) {
      const gate = scanGateBlock(input.text);
      if (!gate?.passed) {
        return { kind: 'gate-failed', step, note: gate?.note ?? '' };
      }
    }
  } else if (!input.ok || input.paused) {
    // Сама стадия не кончилась итогом — шаги после неё рано; решает конвейер.
    return { kind: 'continue', text: input.text, task: input.task };
  }

  const held = run?.held ?? {
    text: input.text.slice(-HELD_TEXT_MAX),
    task: input.task.slice(0, HELD_TASK_MAX),
  };
  const next = steps.find((step) => !done.includes(step.id));
  if (next) {
    done = [...done, next.id];
    return {
      kind: 'step',
      step: next,
      prompt: pathStepPrompt(next, stage, held.task),
      link: withRun(link, { done, pending: next.id, held }),
    };
  }

  // Шаги кончились (или их не было): стадия продолжается своим ответом.
  if (!run) return { kind: 'continue', text: input.text, task: input.task };
  return {
    kind: 'continue',
    text: run.held?.text ?? input.text,
    task: run.held?.task ?? input.task,
    link: withRun(link, { done }),
  };
}

/**
 * Свои шаги группы разговора после стадии. Группа — выбранная в чате (своя или
 * от родителя); `auto` здесь пусто: группу при нём выбирает разбор и пишет
 * ребёнку явным выбором, а до того шагов нет.
 */
export function chatPathSteps(
  groups: readonly {
    id: string;
    scope?: GroupScope;
    flow?: GroupFlow;
    path?: { steps: PathStep[] };
  }[],
  choice: string,
  stage: CascadeStage,
): PathStep[] {
  if (choice === 'auto') return [];
  const group = groups.find((item) => groupKeyOf(item) === choice);
  // Сценарий идёт одной инструкцией (`scenarioLine`), а не ходами после стадий.
  if (!group || group.flow === 'scenario') return [];
  return buildPath(group, []).entries.flatMap((entry) =>
    entry.kind === 'custom' && !entry.step.within && entry.step.anchor === stage
      ? [entry.step]
      : [],
  );
}

/**
 * Путь группы обычному чату — подсказкой в системной дописке. Звеньев у такого
 * чата нет, и ходом после стадии шаги идти не могут: каждый ход человека — это
 * «работа». Раньше эту роль играл скомпилированный скилл сценария с хуком;
 * он снят (`groups/path-migration.ts`), и без подсказки шаги обычного чата
 * пропали бы совсем. Чат конвейера подсказки не получает — там шаги идут сами.
 */
export function chatPathHint(
  groups: readonly {
    id: string;
    name: string;
    scope?: GroupScope;
    flow?: GroupFlow;
    path?: { steps: PathStep[] };
  }[],
  choice: string,
): string | undefined {
  if (choice === 'auto') return undefined;
  const group = groups.find((item) => groupKeyOf(item) === choice);
  if (!group || group.flow === 'scenario') return undefined;
  const lines = buildPath(group, []).entries.flatMap((entry) => {
    // Шаг внутри скилла едет строкой скиллов группы (`skillInsertsLine`).
    if (entry.kind !== 'custom' || entry.step.within) return [];
    const { step } = entry;
    const title = enOf(step.title);
    const gate = enOf(step.gate);
    const body = [enOf(step.prompt), resourceLine(step), gate ? `Closed when: ${gate}.` : undefined]
      .filter(Boolean)
      .join(' ');
    return [`- After ${step.anchor}${title ? ` — ${title}` : ''}: ${body}`];
  });
  if (lines.length === 0) return undefined;
  return [
    `This chat works under the group "${group.name}". Its owner added these steps to the usual ` +
      'flow (plan, work, review, fix, deliver); do each at its point, and when a step has a ' +
      '"closed when" condition, check it and say whether it holds:',
    ...lines,
  ].join('\n');
}

/**
 * Свои шаги ВНУТРИ порядка скиллов группы — строкой дописки: скилл идёт одним
 * ходом, отдельного хода «после шага 4 скилла» не бывает, и место шага модель
 * узнаёт только отсюда. Едет вместе с «числами» группы (`chatKnobsLine`) —
 * туда же, куда и они: обычный чат, звено разделения, чужой CLI.
 */
export function skillInsertsLine(group: {
  name: string;
  path?: { steps: PathStep[] };
}): string | undefined {
  const lines = buildPath({ id: '', ...group }, []).entries.flatMap((entry) => {
    if (entry.kind !== 'custom' || !entry.step.within) return [];
    const { step } = entry;
    const within = step.within!;
    const title = enOf(step.title);
    const gate = enOf(step.gate);
    const place = within.after ? `right after its step "${within.after}"` : 'before its first step';
    const body = [enOf(step.prompt), resourceLine(step), gate ? `Closed when: ${gate}.` : undefined]
      .filter(Boolean)
      .join(' ');
    return [`- Skill \`${within.skillId}\`, ${place}${title ? ` — ${title}` : ''}: ${body}`];
  });
  if (lines.length === 0) return undefined;
  return [
    `The group "${group.name}" inserts its own steps into its skills' numbered order. When you ` +
      'apply such a skill, do each inserted step at its point as part of the skill, and when it ' +
      'has a "closed when" condition, check it before the next skill step:',
    ...lines,
  ].join('\n');
}

/** Тело шага для строки дописки: текст, ресурс, условие закрытия — по-английски. */
function stepBody(step: PathStep): string {
  const gate = enOf(step.gate);
  return [enOf(step.prompt), resourceLine(step), gate ? `Closed when: ${gate}.` : undefined]
    .filter(Boolean)
    .join(' ');
}

/**
 * Сценарий группы — строкой дописки: его шаги по порядку и есть работа. Едет
 * тем же путём, что и «числа» (`chatKnobsLine`): обычный чат и звенья
 * разделения; звено ревью или правок сверяет по нему сделанное, а не делает
 * работу заново.
 */
export function scenarioLine(group: {
  name: string;
  flow?: GroupFlow;
  path?: { steps: PathStep[] };
}): string | undefined {
  if (group.flow !== 'scenario') return undefined;
  const steps = buildPath({ id: '', ...group }, []).entries.flatMap((entry) =>
    entry.kind === 'custom' ? [entry.step] : [],
  );
  if (steps.length === 0) return undefined;
  return [
    `This task follows the scenario "${group.name}". Do its steps in this order, one after ` +
      'another; a step with a "closed when" condition is done only when you have checked it holds. ' +
      'In a review, fix or deliver stage, check the work against these steps instead of redoing them:',
    ...steps.map((step, index) => {
      const title = enOf(step.title);
      return `${index + 1}. ${title ? `${title}: ` : ''}${stepBody(step)}`;
    }),
  ].join('\n');
}
