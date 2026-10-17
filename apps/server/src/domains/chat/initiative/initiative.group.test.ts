import { describe, it, expect } from 'vitest';
import { HANDOFF_BLOCK_LANG, HANDOFF_SYSTEM_PROMPT } from '@agentdeck/contracts/chat-handoff';
import { TASK_NOTEBOOK } from '../task-notebook/task-notebook.ts';
import {
  BACKGROUND_PROMPT,
  CHILD_PROMPT,
  FOREIGN_CHILD_PROMPT,
  GROUP_ECONOMY_PROMPT,
  SPLIT_FOREGROUND_PROMPT,
  QUESTION_PROMPT,
  STEER_PROMPT,
  childAppend,
  initiativePrompt,
} from './initiative.ts';

/**
 * Дописка группы разделения (1.4): та же склейка, что получает обычный чат,
 * переписана под положение группы — короче и без того, что в группе не
 * действует (карточка продолжения человеку, источник с перечнем умений панели).
 * Потолок длины — рычаг расхода: дописка едет в каждом вызове модели каждой
 * группы. Перечень опор — гарантия, что короче не значит беднее: каждое
 * правило, которое группа получала, называется и теперь.
 */
describe('дописка группы разделения', () => {
  const both = { taskSplitInitiative: true, handoffInitiative: true };
  const group = childAppend(initiativePrompt(both, { splitMuted: true }));

  /**
   * 3000 — редакция 1.4 (было 4133); +500 — правило расхода (2.2, 2.4, 3.1, 3.3,
   * 4.1): строка в каждом вызове окупается одним несделанным вызовом на ~170 тыс.;
   * +200 — что сохранить при сжатии (2.1): окупается одним неперечитанным навыком;
   * +150 — тетрадь задачи (9.2): окупается одним поиском, не повторённым после сжатия.
   */
  it('не длиннее 3850 знаков при обоих тумблерах', () => {
    expect(group.length).toBeLessThanOrEqual(3850);
  });

  /**
   * Группа в Codex и Qwen Code (6.1) получает правила первой репликой
   * переписки, и они так же едут в каждом её вызове (этап 7): 1557 знаков на 17.10,
   * +200 — тетрадь задачи (9.2).
   */
  it('правила группы в чужом CLI — не длиннее 1800 знаков', () => {
    expect(`${FOREIGN_CHILD_PROMPT} ${GROUP_ECONOMY_PROMPT}`.length).toBeLessThanOrEqual(1800);
  });

  /**
   * 9.2: факты, найденные по ходу, — в файл копии, который переживает сжатие и
   * виден любому CLI; секрет туда не пишется. Путь — тот, что заводит панель.
   */
  it('правило тетради: факты строкой в файл копии, без секретов, читать до поиска', () => {
    for (const anchor of [
      `one line into ${TASK_NOTEBOOK}`,
      'never a secret',
      'read it before searching again',
      'the notebook path',
    ]) {
      expect(GROUP_ECONOMY_PROMPT, anchor).toContain(anchor);
    }
    expect(group).toContain(TASK_NOTEBOOK);
  });

  it('правило расхода: пачки, одно чтение, правки, короткий вывод, ожидание без опроса', () => {
    expect(group).toContain(GROUP_ECONOMY_PROMPT);
    for (const anchor of [
      'batch independent reads and searches',
      'only after it changed',
      'whole file only when the file is new',
      'log file',
      'the first failure lines and the log path',
      'without polling',
      // Без явного таймаута CLI ждёт гейт две минуты и уводит в фон (B-F05).
      'give a gate or build timeout 1800000 (30 min)',
    ]) {
      expect(GROUP_ECONOMY_PROMPT, anchor).toContain(anchor);
    }
  });

  /**
   * 2.1 и 2.4 плана экономии: дописка едет и в запрос сжатия (проверено на CLI
   * 2.1.286 стабом модели), поэтому правило «что сохранить» правит каждое резюме —
   * и автосжатия, и `/compact`: этапы, решения, пути, доступ к стенду, открытые
   * падения и выжимку шага навыка, чтобы после сжатия не перечитывать его целиком.
   */
  it('правило сжатия: что сохранить в резюме', () => {
    for (const anchor of [
      'When the conversation is compacted',
      'stage ledger',
      'decisions with their reasons',
      'stand access',
      'open failures',
      'current skill step',
    ]) {
      expect(GROUP_ECONOMY_PROMPT, anchor).toContain(anchor);
    }
  });

  it('несёт каждое правило: вопрос, сообщение в работе, этапы, автономию, передний план', () => {
    for (const anchor of [
      'the language the human writes in',
      'AskUserQuestion',
      'Answer questions?',
      'END the turn',
      'do not pick an option for the human',
      'The user sent a new message while you were working',
      'never leave a half-made edit',
      'TodoWrite',
      '/clear',
      '.agent/PROGRESS.md',
      'TASKS.md',
      '.agent/ARCHIVE.md',
      'SPECIFIC next step',
      HANDOFF_BLOCK_LANG,
      '{"done":',
      '"next":',
      '"checkpoint":".agent/PROGRESS.md"',
      '"pruned":',
      'do not retell',
      'recommended option',
      'MR description',
      'irreversible',
      'force-push',
      'other CLI sessions',
      'run_in_background',
      'foreground',
    ]) {
      expect(group, anchor).toContain(anchor);
    }
  });

  it('без того, что в группе не действует: карточки человеку, фона и полных текстов чата', () => {
    expect(group).not.toContain('shows the human a card instead of this block');
    expect(group).not.toContain('cards with buttons');
    expect(group).not.toContain(BACKGROUND_PROMPT);
    expect(group).not.toContain(QUESTION_PROMPT);
    expect(group).not.toContain(STEER_PROMPT);
    expect(group).not.toContain(HANDOFF_SYSTEM_PROMPT);
  });

  it('без продолжения — без правила этапов, остальное на месте', () => {
    const bare = childAppend(
      initiativePrompt(
        { taskSplitInitiative: true, handoffInitiative: false },
        { splitMuted: true },
      ),
    );
    expect(bare).not.toContain(HANDOFF_BLOCK_LANG);
    expect(bare).toContain('Answer questions?');
    expect(bare).toContain('run_in_background');
  });

  /** Ревью A1-F9/B1-F7: схлопывались все двойные пробелы, и отступы человека ломались. */
  it('отступы дописки человека доходят до группы как есть', () => {
    const human = 'Шаги:\n    1. собрать\n    2. проверить  дважды';
    const text = childAppend(`${human} ${BACKGROUND_PROMPT} хвост`);
    expect(text).toContain(human);
    expect(text).not.toContain(BACKGROUND_PROMPT);
    expect(text).toContain('дважды хвост');
    expect(childAppend(`строка\n${BACKGROUND_PROMPT} начало`)).toContain('строка\nначало');
  });

  it('одна строка, правила группы ровно по разу', () => {
    expect(group).not.toContain(String.fromCharCode(10));
    expect(group).not.toMatch(/ {2}/);
    expect(group.split(CHILD_PROMPT)).toHaveLength(2);
    expect(group.split(SPLIT_FOREGROUND_PROMPT)).toHaveLength(2);
  });
});
