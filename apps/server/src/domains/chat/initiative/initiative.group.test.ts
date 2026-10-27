import { describe, it, expect } from 'vitest';
import { HANDOFF_BLOCK_LANG, HANDOFF_SYSTEM_PROMPT } from '@agentdeck/contracts/chat-handoff';
import { TASK_NOTEBOOK } from '../task-notebook/task-notebook.ts';
import { TASK_TICKETS } from '../task-tickets/task-tickets.ts';
import { OWNER_BRIEF } from '../owner-brief/owner-brief.ts';
import { WORK_HABITS_SHARED_NOTE } from '../group-profile/group-profile.ts';
import {
  BACKGROUND_PROMPT,
  CHILD_PROMPT,
  FOREIGN_CHILD_NO_TOOL_LOOP_PROMPT,
  FOREIGN_CHILD_PROMPT,
  FOREIGN_GROUP_ECONOMY_PROMPT,
  GROUP_ECONOMY_PROMPT,
  GROUP_LSP_PROMPT,
  NO_TOOL_LOOP_ECONOMY_PROMPT,
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
   * +150 — тетрадь задачи (9.2): окупается одним поиском, не повторённым после сжатия;
   * +50 — задачи трекера в файле копии (9.5): окупается одним ответом трекера, не
   * легшим в контекст; +220 — LSP вместо grep (9.1): окупается одним поиском по
   * репозиторию, которого не было; +50 — «closed»:true у закрытой группы (L7.2,
   * журнал 19.10): окупается одной незаведённой сессией (там их ушло ~305 тыс.);
   * +170 — полный гейт раз на этап (план скорости гейтов, строка 6): окупается одним
   * несделанным гейтом на 8–13 минут; +170 — правка через Edit, не оболочкой
   * (журнал 19.10 19:42–19:50: 6 отказов стража за 10 минут в трёх группах, каждый —
   * ход по ~190 тыс. контекста): окупается одним отказом. +70 (25.10, журнал группы 1,
   * 23.10) — три правила при ужатых источнике, вопросе, сообщении в работе и этапах:
   * фоновые подагенты — конец хода (два цикла sleep по 700 с), без вопросов и
   * «Waiting for the human: D-n» (три хода AskUserQuestion), `>>` в списке оболочки
   * (отказы стража на дописке в .md). +130 (26.10) — путь к файлу слов владельца:
   * после сжатия группа 2,5 минуты искала их в транскрипте; окупается одним
   * несделанным поиском.
   */
  it('не длиннее 4710 знаков при обоих тумблерах', () => {
    expect(group.length).toBeLessThanOrEqual(4710);
  });

  /**
   * Журнал группы 1 (23.10): лиды ревью ждали фоновых агентов циклом `sleep` над их
   * файлами 698 + 722 с, потому что строка переднего плана звала конец хода
   * «результатом группы». Панель держит группу, пока живы фоновые задачи CLI
   * (`chainOutcomeOf` → `background`), и будит её возвратом агента.
   */
  it('передний план: фоновые подагенты — исключение, ход кончается строкой с их именами', () => {
    for (const anchor of [
      'Background subagents (Agent with run_in_background) are the exception',
      'the panel holds the group while they run',
      'END THE TURN with one line naming them',
      'never sleep-loop on them',
      'a background command dies with the process',
    ]) {
      expect(SPLIT_FOREGROUND_PROMPT, anchor).toContain(anchor);
    }
    expect(SPLIT_FOREGROUND_PROMPT).not.toContain(
      "treats the end of your turn as the group's result",
    );
  });

  /**
   * Без вопросов (23.10, отказы D4/D11/D25): развилку группа решает сама, необратимое
   * панель отказывает и ставит человеку D-n — ход кончается строкой, которую читают
   * `chain-outcome` и `deferred-asks`, а не вопросом.
   */
  it('автономия: не спрашивать, необратимое — строка «Waiting for the human: D-n»', () => {
    for (const anchor of [
      'do not ask',
      'else the one that continues without the human',
      'decision for the review',
      'queues it as D-n',
      '"Waiting for the human: D-n — <what it unblocks>"',
    ]) {
      expect(CHILD_PROMPT, anchor).toContain(anchor);
    }
    expect(CHILD_PROMPT).not.toContain('ONLY with AskUserQuestion');
  });

  /**
   * Дописка в .md оболочкой (`>>`) — отказ стража и потерянный ход (журнал группы 1,
   * 23.10): строка экономии называет `>>` и дописку строки, перенос в архив — с Edit.
   */
  it('дописка строки — тоже Edit: `>>` в списке оболочки, архив переносится с Edit', () => {
    expect(GROUP_ECONOMY_PROMPT).toContain('or a line appended), never through the shell');
    expect(GROUP_ECONOMY_PROMPT).toContain('heredoc, >>, a script writing a file');
    expect(group).toContain('into .agent/ARCHIVE.md with Edit');
  });

  /**
   * Группа в Codex и Qwen Code (6.1) получает правила первой репликой
   * переписки, и они так же едут в каждом её вызове (этап 7): 1557 знаков на 17.10,
   * +200 — тетрадь задачи (9.2), +50 — задачи трекера (9.5). LSP (9.1) сюда не
   * едет: у чужих CLI такого инструмента нет. +170 — полный гейт раз на этап
   * (19.10): 11 гейтов по 8–13 минут на группу стоили дороже этих знаков в вызове.
   * +170 — правка через Edit, не оболочкой (журнал 19.10 19:42–19:50).
   * +170 — P-08 (25.10): «не спрашивай о развилках» и D-n для необратимого шага
   * вместо «спроси, если шаг необратим» — чужая группа вставала на вопросе.
   * +130 (26.10) — путь к файлу слов владельца: Codex и Qwen сжимают переписку так же.
   */
  it('правила группы в чужом CLI — не длиннее 2470 знаков', () => {
    const foreign = `${FOREIGN_CHILD_PROMPT} ${FOREIGN_GROUP_ECONOMY_PROMPT}`;
    expect(foreign.length).toBeLessThanOrEqual(2470);
    expect(foreign).not.toContain('LSP');
  });

  /**
   * P-08 (25.10): ребёнок чужого CLI не спрашивает о развилках, необратимое
   * отдаёт человеку через D-n, а исключения про фоновых подагентов у него нет —
   * конвейер чужих CLI не держит группу на фоне (`chainOutcomeOf` без `background`).
   */
  it('ребёнок чужого CLI не спрашивает, необратимое — D-n, конец хода — результат', () => {
    for (const prompt of [FOREIGN_CHILD_PROMPT, FOREIGN_CHILD_NO_TOOL_LOOP_PROMPT]) {
      expect(prompt).toContain('do not ask about forks');
      expect(prompt).toContain('queues it as D-n');
      expect(prompt).toContain('"Waiting for the human: D-n');
      expect(prompt).not.toContain('Ask only if the step is irreversible');
    }
    expect(FOREIGN_CHILD_PROMPT).toContain('does not hold it for background work');
    expect(FOREIGN_CHILD_PROMPT).not.toContain('run_in_background');
  });

  /**
   * С тумблером «привычки работы» (22.10) звено чужого CLI получает ещё и общую
   * часть заметки о привычках — `foreignChildExtra` склеивает её третьей: +340.
   * Потолок меряет то, что реально едет в каждом вызове, а не две строки из трёх.
   * +170 — P-08 (25.10), как и потолок без привычек. +130 (26.10) — файл слов владельца.
   */
  it('правила группы в чужом CLI с привычками работы — не длиннее 2810 знаков', () => {
    const foreign = [
      FOREIGN_CHILD_PROMPT,
      FOREIGN_GROUP_ECONOMY_PROMPT,
      WORK_HABITS_SHARED_NOTE,
    ].join(' ');
    expect(foreign.length).toBeLessThanOrEqual(2810);
  });

  /**
   * План экономии чужих CLI (22.10): инструмента `Edit` у чужого CLI нет — его
   * вариант строки называет правку без имени, а строка Claude не меняется.
   */
  it('строка экономии чужого CLI — без имени инструмента Edit, остальное то же', () => {
    expect(FOREIGN_GROUP_ECONOMY_PROMPT).not.toContain('with Edit');
    expect(FOREIGN_GROUP_ECONOMY_PROMPT).toContain('edit files (one call per file');
    expect(GROUP_ECONOMY_PROMPT).toContain('edit with Edit (one call per file');
    expect(FOREIGN_GROUP_ECONOMY_PROMPT.replace('edit files (', 'edit with Edit (')).toBe(
      GROUP_ECONOMY_PROMPT,
    );
  });

  /**
   * CLI без цикла инструментов (aider, 23.10): из строки экономии — только тетрадь и
   * задачи трекера, вырезкой из той же строки; переформулировка строки Claude, сдвинувшая
   * опоры вырезки, ловится здесь, а не пустой или чужой строкой у aider.
   */
  it('строка экономии без цикла инструментов — тетрадь и задачи трекера, ничего больше', () => {
    expect(NO_TOOL_LOOP_ECONOMY_PROMPT).toBe(
      'Each fact you had to find out (stand access, commands, ports, places, decisions): one ' +
        `line into ${TASK_NOTEBOOK}, never a secret; read it before searching again. Tracker ` +
        `tasks: read ${TASK_TICKETS} first.`,
    );
    expect(GROUP_ECONOMY_PROMPT).toContain(NO_TOOL_LOOP_ECONOMY_PROMPT);
  });

  /** 9.5: задачи трекера панель кладёт в копию — группа читает файл раньше трекера. */
  it('правило задач трекера: файл копии раньше трекера', () => {
    expect(GROUP_ECONOMY_PROMPT).toContain(`Tracker tasks: read ${TASK_TICKETS} first`);
    expect(group).toContain(TASK_TICKETS);
  });

  /**
   * 9.1: где объявлено и кто вызывает — LSP раньше grep; первый вызов свежей сессии
   * бывает неполным (живой замер 17.10: 1 ссылка из 12), поэтому повтор перед выводом.
   */
  it('правило LSP: раньше grep, неполный первый ответ повторяется', () => {
    expect(group.split(GROUP_LSP_PROMPT)).toHaveLength(2);
    for (const anchor of [
      'findReferences',
      'goToDefinition',
      'incomingCalls',
      'before grep',
      'call again, then grep',
    ]) {
      expect(GROUP_LSP_PROMPT, anchor).toContain(anchor);
    }
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
      // Строка 6 плана скорости гейтов (19.10): между правками — узко, полный гейт раз на этап.
      'Between fixes check only what they touched',
      'full gate runs once per stage, at its end',
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

  /**
   * Живая группа 26.10: после сжатия просьба владельца и номера `owner-N` нашлись
   * только grep'ом по транскрипту (7 вызовов, 2,5 минуты). Путь к файлу, который
   * пишет панель, стоит в системной дописке — она сжатие переживает — у Claude и у
   * чужих CLI; у aider (без сжатия) его нет.
   */
  it('после сжатия слова владельца — одним чтением файла, не поиском по транскрипту', () => {
    expect(OWNER_BRIEF).toBe('.agent/run/owner-request.agent.md');
    expect(group).toContain(`read ${OWNER_BRIEF} (if present), not the transcript`);
    expect(FOREIGN_GROUP_ECONOMY_PROMPT).toContain(OWNER_BRIEF);
    expect(NO_TOOL_LOOP_ECONOMY_PROMPT).not.toContain(OWNER_BRIEF);
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
