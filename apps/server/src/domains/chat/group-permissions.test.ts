import { describe, it, expect } from 'vitest';
import {
  GROUP_REQUEST_IDS,
  resolveGroupPermissions,
  resolveSplitDefaults,
  type GroupRequestId,
} from '@agentdeck/contracts/split-groups';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { recordGroupAnswerNotice } from './group-questions/group-questions.ts';
import {
  forgetGroupQuestions,
  groupDecision,
  noteGroupQuestion,
  recordGroupAutoNotice,
  type GroupAutoApprove,
} from './group-permissions.ts';

/** Строки по умолчанию для группы: запись наружу и снос — человеку, остальное само. */
function group(): GroupAutoApprove {
  const rows = Object.fromEntries(GROUP_REQUEST_IDS.map((id) => [id, 'auto'])) as Record<
    GroupRequestId,
    'auto'
  >;
  return {
    rows: { ...rows, externalWrite: 'human', externalDestroy: 'human' },
    allowEdits: true,
    parentChatId: 'p',
    groupIndex: 1,
  };
}

const decide = (toolName: string, allowedTools?: ReadonlySet<string>): string =>
  groupDecision(group(), {
    toolName,
    input: {},
    guardedPatterns: [],
    ...(allowedTools ? { allowedTools } : {}),
  });

describe('groupDecision — MCP-сервер, отданный брокеру правилом ask', () => {
  /**
   * Журнал 19.10 19:41: группа под `ask` на весь сервер GitLab (L6.2) вставала
   * карточкой на каждом `mr_discussions` — у имени нет глагола чтения, а свой
   * список `allow` CLI к серверу под `ask` уже не применяет.
   */
  it('чтение без глагола в имени (`mr_discussions`) проходит само', () => {
    expect(decide('mcp__gitlab-work__mr_discussions')).toBe('auto');
    expect(decide('mcp__atlassian-work__jira_batch_get_changelogs')).toBe('auto');
    expect(decide('mcp__gitlab-work__wait_for_pipeline')).toBe('auto');
  });

  it('инструмент, разрешённый человеком по имени, не спрашивает', () => {
    const allowed = new Set(['mcp__gitlab-work__frobnicate_things']);
    expect(decide('mcp__gitlab-work__frobnicate_things')).toBe('human');
    expect(decide('mcp__gitlab-work__frobnicate_things', allowed)).toBe('auto');
  });

  it('запись без разрешения по имени и снос даже с ним — человеку', () => {
    const allowed = new Set(['mcp__gitlab-work__delete_branch']);
    expect(decide('mcp__gitlab-work__create_merge_request_note')).toBe('human');
    expect(decide('mcp__gitlab-work__delete_branch', allowed)).toBe('human');
  });
});

describe('groupDecision — строки по умолчанию, ничего не сохранено', () => {
  /**
   * Снимки владельца 19.10: ответ в тред MR, правка своей заметки, вложение в
   * задачу и правка комментария вставали карточкой «Агент просит разрешение».
   * Запись наружу по умолчанию идёт сама с отметкой; снос и слияние — человеку.
   */
  const fresh = (toolName: string): string =>
    groupDecision(
      {
        rows: resolveGroupPermissions(resolveSplitDefaults(undefined).permissions, undefined),
        allowEdits: true,
        parentChatId: 'p',
        groupIndex: 1,
      },
      { toolName, input: { attachments: ['C:/shot.png'] }, guardedPatterns: [] },
    );

  it.each([
    'mcp__gitlab-work__create_merge_request_discussion_note',
    'mcp__gitlab-work__update_merge_request_discussion_note',
    'mcp__gitlab-work__create_merge_request_note',
    'mcp__atlassian-work__jira_update_issue',
    'mcp__atlassian-work__jira_edit_comment',
    'mcp__atlassian-work__jira_add_comment',
  ])('%s — с отметкой, без карточки', (tool) => {
    expect(fresh(tool)).toBe('notify');
  });

  it.each([
    'mcp__gitlab-work__merge_merge_request',
    'mcp__gitlab-work__accept_merge_request',
    'mcp__atlassian-work__jira_delete_issue',
  ])('%s — человеку', (tool) => {
    expect(fresh(tool)).toBe('human');
  });
});

describe('groupDecision — команда оболочки по звеньям (23.10)', () => {
  /**
   * Правило чата раньше судило всю строку: «drop» в `grep` и в теле черновика
   * миграции поднимали строку «база данных». Теперь — только звенья, которые
   * разбор не узнал, и самая строгая из их строк.
   */
  const COPY = 'C:/work/shop-worktrees/fix-PROJ-1-x';
  const bash = (command: string, ignored?: string[]): string =>
    groupDecision(
      {
        ...group(),
        rows: { ...group().rows, database: 'human', filesDelete: 'notify' },
        worktree: COPY,
        // Каталог оболочки известен — иначе относительное удаление человеку (F-29).
        shellCwd: COPY,
        ...(ignored ? { ignored } : {}),
      },
      { toolName: 'Bash', input: { command }, guardedPatterns: [] },
    );

  it('чтение и черновик со словом «drop» — не база', () => {
    expect(bash('grep -rn "drop table" src | head')).toBe('auto');
    expect(bash("cat > migrations/001.sql <<'EOF'\ndrop table users;\nEOF")).toBe('auto');
  });

  it('запись в базу в неузнанном звене — своей строкой', () => {
    expect(bash('git status && psql -c "insert into users values (1)"')).toBe('human');
  });

  it('восстановимое удаление — строкой «удаление файлов», защищённое — человеку', () => {
    expect(bash('rm -rf src', ['secrets'])).toBe('notify');
    // Игнорируемое вне локального слоя — своя уборка (R-C02); локальный слой и
    // секрет — человеку.
    expect(bash('rm -rf e2e/bl/zz-probe-1514.mjs', ['e2e'])).toBe('notify');
    expect(bash('rm -rf secrets', ['secrets'])).toBe('human');
    expect(bash('rm -f e2e/fixtures/tls.key', ['e2e'])).toBe('human');
    expect(bash('rm -rf config', ['config/app.local.json'])).toBe('human');
    expect(bash('rm -rf src')).toBe('human');
  });

  it('своя ветка переставлена на пересобранное — само; удаление временной ветки — человеку (решение владельца 23.10)', () => {
    const own = 'fix-PROJ-1298/chat-permissions-tool-rows';
    const command = `B=${own}; git branch -f $B HEAD 2>&1 | tail -2 && git switch -q $B; git log --oneline -3; git merge-base --is-ancestor origin/main HEAD && echo "on top of origin/main"`;
    // Копия стоит на пересборочной ветке; своя — из записи разделения, дерево чистое.
    const placed: GroupAutoApprove = {
      ...group(),
      worktree: COPY,
      branch: own,
      ownBranch: 'rebuild/proj1298-chat-permissions',
      tree: { dirty: false },
    };
    const request = { toolName: 'Bash', input: { command }, guardedPatterns: [] };
    expect(groupDecision(placed, request)).toBe('auto');
    // Чужая ветка так же — человеку: ветки у копий общие (F-21).
    const foreign = command.replace(`B=${own}`, 'B=feat/other-group');
    expect(groupDecision(placed, { ...request, input: { command: foreign } })).toBe('human');
    // Дерево не прочитано — смену ветки решает человек.
    expect(groupDecision({ ...placed, tree: undefined }, request)).toBe('human');
    expect(bash('git branch -d rebuild/proj1298-chat-permissions 2>&1 | tail -1')).toBe('human');
    expect(bash('git branch -D rebuild/proj1298-chat-permissions')).toBe('human');
  });
});

describe('groupDecision — раунд 10 (24.10): PowerShell, псевдонимы, make -C', () => {
  const COPY = 'C:/work/shop-worktrees/fix-PROJ-1-x';
  const placed = (extra: Partial<GroupAutoApprove> = {}): GroupAutoApprove => ({
    ...group(),
    rows: { ...group().rows, filesDelete: 'notify' },
    worktree: COPY,
    shellCwd: COPY,
    base: 'main',
    branch: 'fix/a',
    ownBranch: 'fix/a',
    ...extra,
  });
  const run = (toolName: string, command: string, extra?: Partial<GroupAutoApprove>): string =>
    groupDecision(placed(extra), { toolName, input: { command }, guardedPatterns: [] });

  /**
   * Инструмент PowerShell шёл мимо разбора: снос `Documents` и пуш в main шли
   * сами. Теперь его команда судится, как `pwsh -Command '…'` из Bash.
   */
  it('PowerShell: снос вне копии и пуш в основную — человеку', () => {
    expect(run('PowerShell', 'Remove-Item -Recurse -Force C:/Users/me/Documents')).toBe('human');
    expect(run('PowerShell', 'Remove-Item -Recurse -Force "C:/Users/me/Documents"')).toBe('human');
    expect(run('PowerShell', 'rm -r -fo ~/Documents')).toBe('human');
    expect(run('PowerShell', 'git push origin HEAD:main --force')).toBe('human');
    expect(run('PowerShell', "Remove-Item -Recurse -Force 'C:/Users/me/it''s'")).toBe('human');
  });

  /**
   * Строку `git …` PowerShell делит не как Bash: типографские кавычки — кавычки,
   * CR — конец оператора, неразрывный пробел — пробел (повторная проверка 24.10).
   */
  it('PowerShell: git со знаками, которые Bash читает буквами, — человеку', () => {
    expect(run('PowerShell', 'git push origin HEAD:\u2018main\u2019')).toBe('human');
    expect(run('PowerShell', 'git push origin \u201cHEAD:main\u201d')).toBe('human');
    expect(run('PowerShell', 'git push origin \u201eHEAD:main\u201d')).toBe('human');
    expect(run('PowerShell', 'git push\u00a0origin\u00a0HEAD:main')).toBe('human');
    expect(run('PowerShell', 'git status\rRemove-Item -Recurse -Force C:/Users/me')).toBe('human');
    expect(run('Bash', 'pwsh -c "git push origin HEAD:\u2018main\u2019"')).toBe('human');
    // Кириллица в сообщении коммита — не разделитель: строка судится разбором git.
    expect(run('PowerShell', 'git commit -m "исправление"')).toBe('auto');
  });

  it('PowerShell: чтение, запись в копии и git status — сами', () => {
    expect(run('PowerShell', 'Get-ChildItem')).toBe('auto');
    expect(run('PowerShell', 'Set-Content out.txt x')).toBe('auto');
    // Кавычки экранированы для Bash-обёртки: '>/c/Windows/x' — данные, не перенаправление.
    expect(run('PowerShell', "Write-Output 'x' '>/c/Windows/x'")).toBe('auto');
    expect(run('PowerShell', 'git status')).toBe('auto');
    // Простая строка `git …` судится разбором git, а не как запись git в обёртке.
    expect(run('PowerShell', 'git commit -m "fix: x y"')).toBe('auto');
    expect(run('PowerShell', 'git push origin HEAD')).toBe('auto');
    expect(run('PowerShell', 'git push origin "HEAD:main"')).toBe('human');
    expect(run('PowerShell', 'git push origin $b')).toBe('human');
    expect(run('PowerShell', 'git add -A; git push origin HEAD')).toBe('human');
  });

  /** `alias gp='git push'` в `.bashrc`: `gp origin main --force` — пуш в main. */
  it('псевдоним снимка оболочки раскрывается перед судом', () => {
    const aliases = {
      gp: 'git push',
      gst: 'git status',
      deploy: 'git push origin HEAD:main && echo ok',
      gpf: 'gp --force',
      loop: 'loop x',
      wipe: 'rm -rf ~ "x',
    };
    // Развёртку не разобрать, а в ней снос — человеку.
    expect(run('Bash', 'wipe', { aliases })).toBe('human');
    expect(run('Bash', 'gp origin main --force', { aliases })).toBe('human');
    expect(run('Bash', 'X=1 gp origin main --force', { aliases })).toBe('human');
    expect(run('Bash', 'deploy', { aliases })).toBe('human');
    expect(run('Bash', 'gpf origin main', { aliases })).toBe('human');
    expect(run('Bash', 'gp origin main --force')).toBe('auto');
    expect(run('Bash', 'gp origin HEAD:fix/a', { aliases })).toBe('auto');
    expect(run('Bash', 'gst', { aliases })).toBe('auto');
    expect(run('Bash', 'loop', { aliases })).toBe('auto');
    expect(run('Bash', 'echo gp origin main --force', { aliases })).toBe('auto');
  });

  /**
   * Псевдоним — подстановка текста: слова вызова приклеиваются к развёртке и с
   * перенаправлением, и после `&&`, а значение с пробелом в конце раскрывает
   * следующее имя (повторная проверка 24.10).
   */
  it('псевдоним с перенаправлением, звеньями или пробелом в конце судится со словами вызова', () => {
    const aliases = {
      gp: 'git push',
      gpl: 'git push 2>/dev/null',
      gfp: 'git fetch && git push',
      gpe: 'git push; echo done',
      s: 'sudo ',
      rmrf: 'rm -rf 2>/dev/null',
    };
    expect(run('Bash', 'gpl origin main --force', { aliases })).toBe('human');
    expect(run('Bash', 'gfp origin HEAD:main', { aliases })).toBe('human');
    expect(run('Bash', 's gp origin HEAD:main', { aliases })).toBe('human');
    expect(run('Bash', 'rmrf C:/Users/me', { aliases })).toBe('human');
    expect(run('Bash', 'rmrf ~/x', { aliases })).toBe('human');
    expect(run('Bash', 'gpl origin <(rm -rf C:/Users/me)', { aliases })).toBe('human');
    // Слова после `;` уходят `echo`, а не пушу; своя ветка и сборка копии — сами.
    expect(run('Bash', 'gpe origin HEAD:main', { aliases })).toBe('auto');
    expect(run('Bash', 'gfp origin HEAD:fix/a', { aliases })).toBe('auto');
    // Удаление в копии — строкой «удаление файлов» (здесь «с отметкой»), как `rm -rf dist`.
    expect(run('Bash', 'rmrf dist', { aliases })).toBe('notify');
    expect(run('Bash', 'gpl', { aliases })).toBe('auto');
  });

  /** Имя из прототипа объекта — не псевдоним: суд не падает исключением. */
  it('имя команды из прототипа объекта при снятых псевдонимах судится как написано', () => {
    const aliases = { gp: 'git push' };
    expect(run('Bash', 'constructor', { aliases })).toBe('auto');
    expect(run('Bash', 'toString x; rm -rf C:/Users/me', { aliases })).toBe('human');
  });

  /** `make -C /c/Users clean` — рецепты чужого дерева. */
  it('make в каталоге вне копии — человеку, в копии — само', () => {
    expect(run('Bash', 'make -C C:/work/other clean')).toBe('human');
    expect(run('Bash', 'make -C ../other clean')).toBe('human');
    expect(run('Bash', 'make --directory=C:/work/other clean')).toBe('human');
    expect(run('Bash', 'make --directory C:/work/other clean')).toBe('human');
    expect(run('Bash', 'make -CC:/work/other clean')).toBe('human');
    expect(run('Bash', 'make -C "$D" clean')).toBe('human');
    expect(run('Bash', 'cd C:/work/other && make clean')).toBe('human');
    expect(run('Bash', 'env -C C:/work/other make clean')).toBe('human');
    expect(run('Bash', 'make -C dist -C ../.. build')).toBe('human');
    expect(run('Bash', 'make -C dist clean')).toBe('auto');
    expect(run('Bash', 'make -C dist -C .. build')).toBe('auto');
    expect(run('Bash', 'make clean')).toBe('auto');
    expect(run('Bash', 'make -j4 test')).toBe('auto');
    expect(run('Bash', 'make -- -C /x')).toBe('auto');
  });

  /** getopt читает пачку `-sC` и начало `--dir` так же, как `-C` и `--directory` (повторная проверка 24.10). */
  it('make: пачка ключей и начало длинного ключа уводят в чужой каталог — человеку', () => {
    expect(run('Bash', 'make -sC C:/work/other clean')).toBe('human');
    expect(run('Bash', 'make -kC/c/work/other clean')).toBe('human');
    expect(run('Bash', 'make --dir=C:/work/other clean')).toBe('human');
    expect(run('Bash', 'make --direc C:/work/other clean')).toBe('human');
    expect(run('Bash', 'make clean -sC C:/work/other')).toBe('human');
    expect(run('Bash', 'make -sC dist clean')).toBe('auto');
    expect(run('Bash', 'make -f Makefile -C dist clean')).toBe('auto');
    // Значение `-f`/`-j` — не ключ: `-fC` читает файл `C`, `-jC` — число.
    expect(run('Bash', 'make -fC/x clean')).toBe('auto');
    expect(run('Bash', 'make --debug=C:/x clean')).toBe('auto');
  });
});

/**
 * F-46: отметки разрешений «с отметкой» и автоответы делили одно окно в 20 —
 * поток автоответов вытеснял разрешения, которые человек обязан видеть.
 */
describe('отметки хаба: у разрешений и ответов окна раздельные', () => {
  const storeOf = () => {
    let plan = {
      parentChatId: 'p',
      groups: [{ index: 1, branch: 'b' }],
    } as unknown as SplitPlanRecord;
    return {
      getSplitPlan: () => plan,
      setSplitPlan: (next: SplitPlanRecord) => void (plan = next),
      notices: () => plan.groups[0]?.autoNotices ?? [],
    };
  };
  const answer = (label: string) => ({ question: 'q', label, critical: false, free: false });

  it('поток автоответов не вытесняет разрешение', () => {
    const store = storeOf();
    recordGroupAutoNotice(store, group(), { toolName: 'Bash', input: { command: 'git push' } });
    for (let i = 0; i < 25; i += 1) recordGroupAnswerNotice(store, group(), [answer(`a${i}`)]);
    const notices = store.notices();
    expect(notices.filter((notice) => notice.kind !== 'answer').map((n) => n.summary)).toEqual([
      'git push',
    ]);
    expect(notices.filter((notice) => notice.kind === 'answer')).toHaveLength(20);
  });

  it('поток разрешений не вытесняет автоответ; разрешений — последние 20', () => {
    const store = storeOf();
    recordGroupAnswerNotice(store, group(), [answer('ответ')]);
    for (let i = 0; i < 25; i += 1) {
      recordGroupAutoNotice(store, group(), { toolName: 'Bash', input: { command: `echo ${i}` } });
    }
    const notices = store.notices();
    expect(notices.filter((notice) => notice.kind === 'answer').map((n) => n.summary)).toEqual([
      'ответ',
    ]);
    const permits = notices.filter((notice) => notice.kind !== 'answer').map((n) => n.summary);
    expect(permits).toHaveLength(20);
    expect(permits.at(-1)).toBe('echo 24');
    expect(permits[0]).toBe('echo 5');
  });
});

/** F-128: счёт повторов вопроса — по группе, разговору и тексту, с потолками. */
describe('повтор вопроса группы', () => {
  it('тот же вопрос считается, другой — отдельно, другой разговор — с нуля', () => {
    forgetGroupQuestions();
    const g = { parentChatId: 'p', groupIndex: 1 };
    expect(noteGroupQuestion(g, 'run-1', ['Что делать?'])).toBe(1);
    // Пробелы и регистр не делают вопрос новым.
    expect(noteGroupQuestion(g, 'run-1', ['  что   делать? '])).toBe(2);
    expect(noteGroupQuestion(g, 'run-1', ['Другое?'])).toBe(1);
    expect(noteGroupQuestion(g, 'run-2', ['Что делать?'])).toBe(1);
    expect(noteGroupQuestion({ ...g, groupIndex: 2 }, 'run-1', ['Что делать?'])).toBe(1);
  });

  it('счёт ограничен по числу групп: давно молчавшая вытесняется', () => {
    forgetGroupQuestions();
    const first = { parentChatId: 'p', groupIndex: 0 };
    noteGroupQuestion(first, 'r', ['q']);
    for (let i = 1; i <= 256; i += 1)
      noteGroupQuestion({ parentChatId: 'p', groupIndex: i }, 'r', ['q']);
    expect(noteGroupQuestion(first, 'r', ['q'])).toBe(1);
  });
});
