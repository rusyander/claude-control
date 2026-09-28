import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import {
  SPLIT_SYSTEM_PROMPT,
  chatDeliveryPrompt,
  deliveryPreamble,
  environmentPreamble,
  splitTicketPreamble,
} from '@agentdeck/contracts/task-split';
import {
  HANDOFF_SYSTEM_PROMPT,
  buildHandoffPrompt,
  buildTreeResumePrompt,
  continueFromCheckpoint,
  restartRequestPrompt,
} from '@agentdeck/contracts/chat-handoff';
import {
  composeGroupNotes,
  planStagePrompt,
  triageStagePrompt,
  workAfterPlanPrompt,
} from '@agentdeck/contracts/split-plan';
import { initiativePrompt, childAppend } from '../domains/chat/initiative.ts';
import { childrenBrief } from '../domains/chat/children-brief.ts';
import { tellPrompt } from '../domains/chat/child-tell.ts';
import { mrWatchPrompt } from '../domains/chat/mr-watch.ts';
import { retryPrompt } from '../domains/chat/run-retry.ts';
import { groupIdentityLine } from '../domains/chat/panel-preamble.ts';
import {
  deliveryNudgePrompt,
  interruptResumePrompt,
  limitResumePrompt,
  pauseResumePrompt,
} from '../domains/chat/split-conveyor.ts';
import { buildPrompt } from '../domains/project-tests/prompt.ts';
import {
  decidePermission,
  describeScope,
  runScope,
} from '../domains/project-tests/run-permissions.ts';
import { serverText } from '../lib/server-texts.ts';
import { sealFooter } from '@agentdeck/contracts/panel-agent-feed';

/**
 * Всё, что панель шлёт модели, — по-английски; язык ОТВЕТА следует за
 * человеком (решение владельца D-E, 27.09.2026). Русское задание вело к
 * русскому ответу там, где человек пишет по-английски, и наоборот.
 *
 * Сторож `server-ru-literals` считает русские строки без кода, но не отличает
 * «уходит модели» от «уходит человеку» — это делает `why` закрепки. Здесь та
 * граница проверяется тремя путями:
 * - файлы заданий модели держат НОЛЬ кириллических литералов (закодированные
 *   тоже: код переводит текст человеку, а модели уходит русская строка);
 *   функции, которые пишут текст человеку, названы поимённо;
 * - закрепка, чей `why` называет текст для модели, красная — если это не
 *   объявленный пробел (`KNOWN GAP`) чужой полосы;
 * - сборщики заданий вызываются по-настоящему, и в собранном тексте нет
 *   кириллицы: литерал — не единственный путь (серверный текст, склейка).
 */
const SRC = resolve(import.meta.dirname, '..');
const CONTRACTS = resolve(SRC, '../../../packages/contracts/src');
const PINS = join(import.meta.dirname, 'server-ru-literals.pins.json');
const CYRILLIC = /[А-Яа-яЁё]/;

interface ModelFile {
  path: string;
  /** Функции/константы файла, которые пишут текст ЧЕЛОВЕКУ (название, карточка, отказ). */
  human?: string[];
}

/** Файлы, чьё назначение — текст модели. Новый сборщик задания — сюда. */
const MODEL_FILES: ModelFile[] = [
  { path: join(CONTRACTS, 'task-split.ts') },
  { path: join(CONTRACTS, 'model-cascade.ts') },
  {
    path: join(CONTRACTS, 'chat-handoff.ts'),
    // `done` карточки продолжения и заголовки, которые видит человек.
    human: [
      'contextHandoffProposal',
      'scanHandoffProse',
      'restartHandoffProposal',
      'overflowHandoffProposal',
    ],
  },
  // Починки разбора — лента человека (`repairs`), не задание.
  { path: join(CONTRACTS, 'split-plan.ts'), human: ['applySplitPlan'] },
  { path: join(SRC, 'domains/chat/initiative.ts') },
  { path: join(SRC, 'domains/chat/children-brief.ts') },
  { path: join(SRC, 'domains/chat/child-tell.ts') },
  { path: join(SRC, 'domains/chat/mr-watch.ts') },
  { path: join(SRC, 'domains/chat/run-retry.ts') },
  { path: join(SRC, 'domains/chat/ChatBranchGate.ts') },
  { path: join(SRC, 'domains/chat/ChatPermissions.ts') },
  // Мост прав: отказы уходят агенту результатом вызова (F-51).
  { path: join(SRC, 'domains/chat/permission-prompt-server.mjs') },
  // Хвост запечатанного ответа агента панели уходит модели следующим ходом (F-50).
  { path: join(CONTRACTS, 'panel-agent-feed.ts') },
  {
    path: join(SRC, 'domains/panel-agent/conversations.ts'),
    human: ['writePanelAgentConversation'],
  },
  { path: join(SRC, 'domains/chat/panel-preamble.ts') },
  { path: join(SRC, 'domains/integrations/links.ts'), human: ['requirePath'] },
  { path: join(SRC, 'domains/provider-check/steps-assistant.ts') },
  { path: join(SRC, 'domains/resources/ResourceAssistant.ts'), human: ['assistStructure'] },
  { path: join(SRC, 'domains/provider-chat/prompt.ts') },
  { path: join(SRC, 'domains/project-tests/convention.ts') },
  // Имя прогона — название в списке чатов. Метка регресса — данные библиотеки на
  // её языке (F-63): по ней человек отбирает кейсы, и «regression» в русской
  // библиотеке выпадал из фильтра «регресс».
  {
    path: join(SRC, 'domains/project-tests/prompt.ts'),
    human: ['runName', 'RUN_NAME_WORDS', 'regressionTag', 'REGRESSION_TAGS'],
  },
  { path: join(SRC, 'domains/portability/supervisor/skills-router.ts') },
  { path: join(SRC, 'domains/portability/supervisor/subagents.ts') },
  { path: join(SRC, 'routes/panel-agent/actions-projects.ts') },
  { path: join(SRC, 'routes/panel-agent/actions-contour.ts') },
  { path: join(SRC, 'routes/panel-agent/actions-tests-library.ts') },
];

/** Имя ближайшего объявления: функция, метод или переменная верхнего уровня. */
function ownerOf(node: ts.Node): string | undefined {
  let name: string | undefined;
  for (let current = node.parent; current; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isVariableDeclaration(current)) &&
      current.name &&
      ts.isIdentifier(current.name)
    )
      name = current.name.text;
  }
  return name;
}

/** Кириллические строковые литералы файла вне функций человека: `строка:текст`. */
function cyrillicLiterals(path: string, text: string, human: readonly string[] = []): string[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const value =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : ts.isTemplateExpression(node)
          ? node.getText(file)
          : undefined;
    if (value !== undefined && CYRILLIC.test(value) && !ts.isLiteralTypeNode(node.parent)) {
      const owner = ownerOf(node);
      if (!owner || !human.includes(owner)) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        found.push(`${line}:${value.slice(0, 60)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** `why`, называющий текст для модели. */
const MODEL_WHY =
  /model reads|agent prompt|prompt the model|probe prompt|smoke prompt|tool description|text the (TARGET )?model/i;

/** Всё собранное задание — без кириллицы; ключ — какой сборщик виноват. */
function russianIn(texts: Record<string, string | undefined>): string[] {
  return Object.entries(texts)
    .filter(([, text]) => text !== undefined && CYRILLIC.test(text))
    .map(
      ([name, text]) =>
        `${name}: …${text!.slice(text!.search(CYRILLIC), text!.search(CYRILLIC) + 60)}`,
    );
}

describe('всё, что панель шлёт модели, — по-английски (D-E)', () => {
  it('файлы заданий модели не держат ни одного кириллического литерала', () => {
    const drift: string[] = [];
    for (const item of MODEL_FILES) {
      const found = cyrillicLiterals(item.path, readFileSync(item.path, 'utf8'), item.human);
      for (const hit of found) drift.push(`${item.path.replaceAll('\\', '/')}:${hit}`);
    }
    expect(drift).toEqual([]);
  });

  it('закрепка с текстом для модели — только объявленный пробел чужой полосы', () => {
    const pins = JSON.parse(readFileSync(PINS, 'utf8')) as Record<string, { why: string }>;
    const claimed = Object.entries(pins)
      .filter(([, pin]) => MODEL_WHY.test(pin.why) && !pin.why.startsWith('KNOWN GAP'))
      .map(([file, pin]) => `${file}: ${pin.why.slice(0, 80)}`);
    expect(claimed).toEqual([]);
  });

  it('собранные задания — без кириллицы, даже со строками панели внутри', () => {
    // Входы — латиница: слова человека в задании законно русские, проверяется
    // только то, что дописала панель. Строка недостачи доставки — настоящий
    // русский серверный текст: он обязан приехать к модели переведённым.
    const gap = serverText('delivery-gap-fix-missing', { count: 2 });
    const group = {
      index: 0,
      title: 'Header',
      branch: 'feature/header',
      after: [],
      status: 'failed' as const,
      error: 'copy failed',
      retries: 2,
      chatId: 'work-1',
    };
    const cases = [
      {
        id: 'gui-001',
        title: 'Send a message',
        status: 'unknown',
        steps: [{ action: 'Press Send', data: 'hi', expected: 'shown' }],
        priority: 'high',
        oracle: 'text on screen',
      },
    ];
    const groups = [
      { id: 'gui', title: 'GUI', file: '.agent/tests/gui.tests.json', cases },
    ] as never;
    const scope = runScope('/repo', 'automate', cases as never, 'e2e');
    const proposal = {
      done: 'x',
      next: 'Write the tests',
      checkpoint: '.agent/PROGRESS.md',
    } as never;

    const built: Record<string, string | undefined> = {
      SPLIT_SYSTEM_PROMPT,
      HANDOFF_SYSTEM_PROMPT,
      chatDelivery: chatDeliveryPrompt({}),
      chatDeliveryForeign: chatDeliveryPrompt({ foreign: true, skill: 'x-delivery' }),
      delivery: deliveryPreamble({ branch: 'feature/header' }),
      deliveryHuman: deliveryPreamble({ branch: 'b', mergeRequest: 'u', questions: 'human' }),
      environment: environmentPreamble({}),
      environmentFailed: environmentPreamble({
        mirror: 'Local layer: 3 copied',
        bootstrap: { status: 'failed', command: 'pnpm i', exitCode: 1, logTail: 'ERR' } as never,
      }),
      tickets: splitTicketPreamble(),
      handoff: buildHandoffPrompt(proposal, 'Fix the form'),
      handoffGroup: buildHandoffPrompt(proposal, 'Fix the form', { group: true }),
      treeResume: buildTreeResumePrompt(),
      continue: continueFromCheckpoint('.agent/PROGRESS.md'),
      restart: restartRequestPrompt('.agent/PROGRESS.md'),
      triage: triageStagePrompt({
        shared: 'Shared',
        groups: [
          { title: 'Header', branch: 'feature/header', tasks: ['align'], kind: 'mechanical' },
        ],
      }),
      plan: planStagePrompt({
        title: 'Header',
        branch: 'b',
        task: 't',
        owns: ['a.ts'],
        workModel: 'sonnet',
      }),
      workWithPlan: workAfterPlanPrompt({ task: 't', plan: 'p' }),
      workNoPlan: workAfterPlanPrompt({ task: 't', notes: 'n' }),
      notes: composeGroupNotes({
        predecessors: [
          { title: 'A', branch: 'a', failed: true, files: ['x.ts'], filesTotal: 3 },
          { title: 'B', branch: 'b', unfinished: true, filesTotal: 2 },
        ],
        base: 'a',
        holdAnswer: { question: 'q', answer: 'a' },
      }),
      initiative: initiativePrompt({ taskSplitInitiative: true, handoffInitiative: true }),
      initiativeBare: initiativePrompt({ taskSplitInitiative: false, handoffInitiative: false }),
      child: childAppend(undefined),
      children: childrenBrief({ parentChatId: 'p', order: [0], groups: [group] } as never),
      tell: tellPrompt('hello'),
      mrWatch: mrWatchPrompt({
        branch: 'b',
        mr: 'u',
        threads: [],
        red: { id: 1, status: 'failed' } as never,
      }),
      retry: retryPrompt('boom'),
      identity: groupIdentityLine('b', ['PROJ-1']),
      nudge: deliveryNudgePrompt('b', [gap]),
      interrupt: interruptResumePrompt('b'),
      limit: limitResumePrompt('b'),
      pause: pauseResumePrompt('b'),
      testsGenerate: buildPrompt(groups, { projectPath: '/p', mode: 'generate', groupId: 'gui' }),
      testsRun: buildPrompt(groups, { projectPath: '/p', mode: 'run' }),
      testsExplore: buildPrompt(groups, { projectPath: '/p', mode: 'explore' }),
      testsAutomate: buildPrompt(groups, { projectPath: '/p', mode: 'automate' }),
      scope: describeScope(scope),
      denyAsk: decidePermission(scope, 'AskUserQuestion', {}).message,
      sealed: sealFooter({ reason: 'restart', actions: ['toggle_rule', 'where_am_i (failed)'] }),
      sealedFailed: sealFooter({ reason: 'failed', actions: [], detail: 'The CLI exited' }),
      denyWrite: decidePermission(scope, 'Write', { file_path: '/elsewhere/x.ts' }).message,
      denyGit: decidePermission(scope, 'Bash', { command: 'git push' }).message,
    };
    expect(CYRILLIC.test(gap)).toBe(true);
    expect(russianIn(built)).toEqual([]);
  });

  it('сторож видит русский литерал и русскую строку в собранном задании (must-fail)', () => {
    const probe = [
      "export function prompt(): string { return 'Сделай это'; }",
      'export const LINE = `Ветка ${1}`;',
      "export function runName(): string { return 'Тесты'; }",
      '// комментарий по-русски не литерал',
      "const re = /Ветка/; type T = 'Ветка';",
    ].join('\n');
    // Два литерала задания; название — функция человека; комментарий, регэксп и тип — не текст.
    expect(cyrillicLiterals('probe.ts', probe, ['runName'])).toHaveLength(2);
    expect(cyrillicLiterals('probe.ts', probe)).toHaveLength(3);
    expect(russianIn({ ok: 'Fix it', bad: 'Fix it. Ответ по-русски' })).toEqual([
      'bad: …Ответ по-русски',
    ]);
    expect(MODEL_WHY.test('agent prompt / text the model reads')).toBe(true);
  });
});
