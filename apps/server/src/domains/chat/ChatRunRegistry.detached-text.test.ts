import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HANDOFF_BLOCK_LANG } from '@agentdeck/contracts/chat-handoff';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import { ChatSession } from './ChatSession.ts';
import { HandoffChains } from './ChatHandoff.ts';
import { readLastAssistantTurn } from './ChatHistory.ts';
import { createHandoffPlanner } from '../../routes/chat/handoff-routes.ts';
import type { RunLedgerEntry } from './run-ledger.ts';
import type { ChainOutcome } from './split-conveyor.ts';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';

/**
 * Ответ усыновлённого прогона читается из транскрипта.
 *
 * Проверка идёт по НАСТОЯЩЕМУ пути: файл транскрипта лежит на диске, файл-опора
 * тоже, читает его тот же `readLastAssistantTurn`, что стоит в bootstrap, а
 * решение принимает настоящий планировщик продолжений. Собранная руками строка,
 * поданная прямо в разборщик, доказала бы разборщик, а не то, что панель
 * перестала выбрасывать ответ прогона, подхваченного после перезапуска.
 */

const SESSION_ID = 'sess-adopted-1';
const LIVE_PROMPT = 'продолжи руками';

function line(record: unknown): string {
  return JSON.stringify(record);
}

function assistant(id: string, blocks: unknown[]): string {
  return line({
    type: 'assistant',
    uuid: `${id}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    message: { id, role: 'assistant', model: 'claude-opus-5', content: blocks },
  });
}

function toolResult(id: string): string {
  return line({
    type: 'user',
    uuid: `res-${id}`,
    timestamp: new Date().toISOString(),
    toolUseResult: { stdout: '' },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ок' }] },
  });
}

const PROPOSAL = {
  done: 'этап закрыт',
  next: 'дальше — документация',
  checkpoint: '.agent/PROGRESS.md',
};

const ANSWER = [
  'Работа закончена.',
  '```' + HANDOFF_BLOCK_LANG,
  JSON.stringify(PROPOSAL),
  '```',
].join('\n');

describe('усыновлённый прогон — ответ из транскрипта', () => {
  let root: string;
  let project: string;
  let started: { chatId: string; prompt: string }[];
  let registry: ChatRunRegistry;

  /** Записать транскрипт сессии так, как это делает Claude Code. */
  function writeTranscript(lines: string[]): void {
    const dir = join(root, 'projects', '-tmp-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SESSION_ID}.jsonl`), lines.join('\n') + '\n', 'utf8');
  }

  /** Живой CLI из журнала: процесс умирает, когда тест этого захочет. */
  function adopt(alive: { value: boolean }): void {
    const entry: RunLedgerEntry = {
      key: SESSION_ID,
      sessionId: SESSION_ID,
      cwd: project,
      projectPath: project,
      pid: 424242,
      startedAt: Date.now() - 1_000,
    };
    expect(
      registry.adopt(entry, { isAlive: () => alive.value, kill: () => undefined, pollMs: 5 }),
    ).toBe(true);
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-adopted-'));
    project = mkdtempSync(join(tmpdir(), 'cc-adopted-proj-'));
    // Файл-опора существует и записан ПОСЛЕ старта прогона: один из
    // предохранителей продолжения, и подменять его нечем — он настоящий.
    mkdirSync(join(project, '.agent'), { recursive: true });
    writeFileSync(join(project, '.agent', 'PROGRESS.md'), 'сделано: всё', 'utf8');

    started = [];
    registry = new ChatRunRegistry((): RunLike => ({
      start: (options) => {
        started.push({ chatId: options.permissionPrompt?.runId ?? '', prompt: options.prompt });
        // Прогон «в работе»: процесс не кончается, пока тест не закроет реестр.
        return options.prompt === LIVE_PROMPT
          ? new Promise<void>(() => undefined)
          : Promise.resolve();
      },
      stop: () => undefined,
    }));
    registry.setClosingTurnReader((chatId, sessionId) =>
      readLastAssistantTurn(join(root, 'projects'), sessionId ?? chatId),
    );
    registry.setHandoffPlanner(
      createHandoffPlanner({
        runs: registry,
        chains: new HandoffChains(() => true),
        session: new ChatSession(registry),
        selfBaseUrl: 'http://127.0.0.1:5178',
        contextLimit: () => 0,
      }),
    );
  });

  afterEach(() => {
    registry.stopAll();
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('закрывающий ход с блоком продолжения заводит чистую сессию', async () => {
    writeTranscript([
      assistant('msg-1', [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: {} }]),
      toolResult('tu-1'),
      assistant('msg-2', [{ type: 'text', text: ANSWER }]),
    ]);
    const alive = { value: true };
    adopt(alive);

    alive.value = false;
    await settle();

    expect(started).toHaveLength(1);
    expect(started[0]?.prompt).toContain(PROPOSAL.next);
    expect(started[0]?.prompt).toContain(PROPOSAL.checkpoint);
  });

  it('ход, оборванный на вызове инструмента, закрывающим не считается — молчим', async () => {
    writeTranscript([
      assistant('msg-1', [{ type: 'text', text: ANSWER }]),
      assistant('msg-1', [{ type: 'tool_use', id: 'tu-9', name: 'Bash', input: {} }]),
    ]);
    const alive = { value: true };
    adopt(alive);

    alive.value = false;
    await settle();

    expect(started).toEqual([]);
  });

  it('транскрипт, кончающийся результатом инструмента, закрывающего хода не даёт', async () => {
    writeTranscript([
      assistant('msg-1', [{ type: 'text', text: ANSWER }]),
      assistant('msg-1', [{ type: 'tool_use', id: 'tu-7', name: 'Bash', input: {} }]),
      toolResult('tu-7'),
    ]);
    const alive = { value: true };
    adopt(alive);

    alive.value = false;
    await settle();

    expect(started).toEqual([]);
  });

  it('транскрипта нет вовсе — прогон закрывается молча, ничего не падает', async () => {
    const alive = { value: true };
    adopt(alive);

    alive.value = false;
    await settle();

    expect(started).toEqual([]);
  });

  /**
   * Группа разделения, усыновлённая после перезапуска (живой прогон 24.09, 98 и
   * 120 журнала): признак «спросил инструментом» ставило только событие потока,
   * а потока у усыновлённого нет. Отказ панели в `AskUserQuestion` велит
   * «скажи, что ждёшь ответа», закрывающий ход — обычный текст, и группа
   * считалась сделанной: заводилось ревью, пока вопрос висел.
   */
  describe('группа разделения', () => {
    const LINK: ChatLink = {
      parentChatId: 'родитель',
      createdAt: '2026-09-24T10:00:00.000Z',
      title: 'Фиксы',
      branch: 'fix/PROJ-1',
      model: 'sonnet',
      effort: 'medium',
      lowered: true,
      stage: 'work',
      groupIndex: 8,
      ceilingModel: 'claude-opus-5',
      ceilingEffort: 'high',
    };
    const GROUP_IDENTITY = 'Ветка группы: fix/PROJ-1. Задачи группы: PROJ-1.';

    function withSplit(): {
      ended: ChainOutcome[];
      interrupted: ChatLink[];
      links: Map<string, ChatLink>;
    } {
      const ended: ChainOutcome[] = [];
      const interrupted: ChatLink[] = [];
      const links = new Map<string, ChatLink>([[SESSION_ID, LINK]]);
      registry.setHandoffPlanner(
        createHandoffPlanner({
          runs: registry,
          chains: new HandoffChains(() => true),
          session: new ChatSession(registry),
          selfBaseUrl: 'http://127.0.0.1:5178',
          cascade: {
            linkOf: (aliases) => aliases.map((key) => links.get(key)).find(Boolean),
            saveLink: (chatId, link) => void links.set(chatId, link),
            markReviewed: () => undefined,
            hasWork: () => true,
            settings: () => ({ taskSplitInitiative: true, handoffInitiative: false }),
          },
          split: {
            onTriageFinished: () => undefined,
            onChainEnded: (_link, outcome) => void ended.push(outcome),
            onChainInterrupted: (link) => void interrupted.push(link),
            identityOf: (link) => (link.branch === LINK.branch ? GROUP_IDENTITY : undefined),
          },
        }),
      );
      return { ended, interrupted, links };
    }

    /**
     * Процесс группы умер посреди хода (журнал 39, 110): закрывающего ответа
     * нет, и раньше планировщик вовсе не звался — группа стояла «работает»
     * навсегда. Теперь это обрыв: ни звена, ни итога, группа прервана (WP1c).
     */
    it('процесс умер посреди хода — группа прервана, ни итога, ни звена', async () => {
      const { ended, interrupted } = withSplit();
      writeTranscript([
        human('сделай тикеты группы'),
        assistant('msg-1', [{ type: 'text', text: 'Начинаю.' }]),
        assistant('msg-1', [{ type: 'tool_use', id: 'tu-b', name: 'Bash', input: {} }]),
        toolResult('tu-b'),
      ]);
      const alive = { value: true };
      adopt(alive);

      alive.value = false;
      await settle();

      expect(interrupted).toEqual([LINK]);
      expect(ended).toEqual([]);
      expect(started).toEqual([]);
    });

    /**
     * Второй агент в той же копии (журнал 90): человек продолжил группу руками
     * (или панель напомнила), и в её каталоге идёт другой прогон. Конец ЭТОГО
     * хода не решает ничего — ни звена поверх живого дерева, ни итога группы.
     */
    it('в копии идёт другой прогон той же группы — ни звена, ни итога', async () => {
      const { ended, interrupted, links } = withSplit();
      links.set('другой', { ...LINK, stage: 'review' });
      writeTranscript([
        human('сделай тикеты группы'),
        assistant('msg-1', [{ type: 'text', text: 'Сделал, тесты зелёные.' }]),
      ]);
      const alive = { value: true };
      adopt(alive);
      expect(
        registry.start('другой', { prompt: LIVE_PROMPT, cwd: project }, { projectPath: project }),
      ).toBe(true);

      alive.value = false;
      await settle();

      expect(interrupted).toEqual([]);
      expect(ended).toEqual([]);
      expect(started.map((run) => run.prompt)).toEqual([LIVE_PROMPT]);
    });

    /**
     * Проект без git (итоговое ревью 25.09, M1): копий нет, все группы работают
     * в одном каталоге. Прогон ДРУГОЙ группы там же не должен глотать итог этой —
     * иначе она навсегда «запущена», держит слот, зависимые не стартуют.
     */
    it.each([
      ['другой группы', { ...LINK, groupIndex: 3 }],
      ['без связи (человек в родителе)', undefined],
    ])('в общем каталоге идёт прогон %s — итог группы записан', async (_name, other) => {
      const { ended, links } = withSplit();
      if (other) links.set('другой', other);
      writeTranscript([
        human('сделай тикеты группы'),
        assistant('msg-1', [{ type: 'text', text: 'Сделал, тесты зелёные.' }]),
      ]);
      const alive = { value: true };
      adopt(alive);
      expect(
        registry.start('другой', { prompt: LIVE_PROMPT, cwd: project }, { projectPath: project }),
      ).toBe(true);

      alive.value = false;
      await settle();

      expect(ended).toHaveLength(1);
    });

    /**
     * Заглушка CLI (журнал 96): при `--resume` CLI сам пишет «ответ»
     * «No response requested.» с `model: <synthetic>` до первого слова модели.
     * Процесс, умерший после неё, ход не закончил — это обрыв, а не итог с
     * заглушкой вместо ответа.
     */
    it.each([
      ['модель <synthetic>', '<synthetic>', 'Ответа не требуется.'],
      ['текст заглушки', 'claude-opus-5', 'No response requested.'],
    ])('заглушка CLI концом хода не считается (%s)', async (_name, model, text) => {
      const { ended, interrupted } = withSplit();
      writeTranscript([
        human('сделай тикеты группы'),
        assistant('msg-1', [{ type: 'text', text: 'Сделал половину.' }]),
        human('продолжай'),
        line({
          type: 'assistant',
          uuid: 'synthetic-1',
          timestamp: new Date().toISOString(),
          message: { id: 'msg-s', role: 'assistant', model, content: [{ type: 'text', text }] },
        }),
      ]);
      const alive = { value: true };
      adopt(alive);

      alive.value = false;
      await settle();

      expect(ended).toEqual([]);
      expect(interrupted).toEqual([LINK]);
    });

    it('ход дописан до конца — это итог, а не обрыв', async () => {
      const { ended, interrupted } = withSplit();
      writeTranscript([
        human('сделай тикеты группы'),
        assistant('msg-1', [{ type: 'text', text: 'Сделал, тесты зелёные.' }]),
      ]);
      const alive = { value: true };
      adopt(alive);

      alive.value = false;
      await settle();

      expect(interrupted).toEqual([]);
      expect(ended.length + started.length).toBeGreaterThan(0);
    });

    // Журнал 98: звено группы (здесь ревью) знает ветку и задачи с первой строки.
    it('звено за группой начинается с её ветки и задач', async () => {
      withSplit();
      writeTranscript([
        human('сделай тикеты группы'),
        assistant('msg-1', [{ type: 'text', text: 'Сделал, тесты зелёные.' }]),
      ]);
      const alive = { value: true };
      adopt(alive);

      alive.value = false;
      await settle();

      expect(started).toHaveLength(1);
      expect(started[0]?.prompt.startsWith(`${GROUP_IDENTITY}\n\n`)).toBe(true);
    });

    function human(text: string): string {
      return line({
        type: 'user',
        uuid: `human-${Math.random().toString(36).slice(2)}`,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: text },
      });
    }

    function denied(id: string): string {
      return line({
        type: 'user',
        uuid: `res-${id}`,
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: id,
              is_error: true,
              content:
                'Вопрос показан человеку карточкой с кнопками, ответ придёт следующим сообщением.',
            },
          ],
        },
      });
    }

    it('ход с AskUserQuestion — группа ждёт человека, ревью не заводится', async () => {
      const { ended } = withSplit();
      writeTranscript([
        human('сделай тикеты группы'),
        assistant('msg-1', [
          { type: 'tool_use', id: 'tu-q', name: 'AskUserQuestion', input: { questions: [] } },
        ]),
        denied('tu-q'),
        assistant('msg-2', [{ type: 'text', text: 'Вопрос в карточке, продолжу после выбора.' }]),
      ]);
      const alive = { value: true };
      adopt(alive);

      alive.value = false;
      await settle();

      expect(started).toEqual([]);
      expect(ended).toEqual([
        expect.objectContaining({ status: 'awaiting', waitingFor: 'question' }),
      ]);
    });

    it('вопрос прошлого хода, на который человек уже ответил, новый ход не держит', async () => {
      const { ended } = withSplit();
      writeTranscript([
        assistant('msg-1', [
          { type: 'tool_use', id: 'tu-q', name: 'AskUserQuestion', input: { questions: [] } },
        ]),
        denied('tu-q'),
        assistant('msg-2', [{ type: 'text', text: 'Вопрос в карточке, продолжу после выбора.' }]),
        human('красный'),
        assistant('msg-3', [{ type: 'text', text: 'Сделал красным, тесты зелёные.' }]),
      ]);
      const alive = { value: true };
      adopt(alive);

      alive.value = false;
      await settle();

      expect(ended.map((outcome) => outcome.status)).not.toContain('awaiting');
      expect(started.length).toBeGreaterThan(0);
    });
  });
});
