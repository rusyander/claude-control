import { describe, it, expect } from 'vitest';
import {
  branchTaken,
  buildGroupPrompt,
  parseSplitProposal,
  safeBranchName,
  scanSplitBlocks,
  SPLIT_MAX_GROUPS,
  SPLIT_MAX_TASKS_PER_GROUP,
  SPLIT_SYSTEM_PROMPT,
  type TaskSplitProposal,
} from '@agentdeck/contracts/task-split';
import { splitTasks, type SplitGit, type SplitTasksInput } from './ChatSplit.ts';

/**
 * Разделение задач по чатам. Проверяем ровно то, из-за чего эта штука может
 * навредить: что показывается человеку вместо блока, какие имена веток уходят в
 * git и что происходит с остальными группами, когда одна не завелась.
 */

const PROPOSAL: TaskSplitProposal = {
  shared: 'Общий контекст',
  groups: [
    {
      title: 'Форма входа',
      branch: 'feature/login',
      tasks: ['починить валидацию'],
      brief: 'аккуратно',
    },
    { title: 'Шапка', branch: 'feature/header', tasks: ['убрать лишний отступ', 'выровнять'] },
  ],
};

function block(json: unknown): string {
  return ['```agentdeck:split', JSON.stringify(json), '```'].join('\n');
}

/** git-заглушка: помнит, что у неё просили, и ничего не запускает. */
function fakeGit(overrides: Partial<SplitGit> = {}): SplitGit & { added: string[] } {
  const added: string[] = [];
  return {
    added,
    isRepo: () => true,
    takenBranches: async () => [],
    addWorktree: async (_dir, branch) => {
      added.push(branch);
      return { path: `/copies/${branch.replace(/\//g, '-')}` };
    },
    ...overrides,
  };
}

describe('блок предложения в ответе агента', () => {
  it('прячется из показа, а его содержимое становится предложением', () => {
    const scan = scanSplitBlocks(`Вот план.\n\n${block(PROPOSAL)}\n\nЖду решения.`);

    expect(scan.text).toBe('Вот план.\n\nЖду решения.');
    expect(scan.proposals).toHaveLength(1);
    expect(scan.proposals[0]?.groups.map((group) => group.branch)).toEqual([
      'feature/login',
      'feature/header',
    ]);
  });

  it('со сломанным JSON остаётся в тексте как есть — прятать непонятое нельзя', () => {
    const broken = '```agentdeck:split\n{ это не json }\n```';
    const scan = scanSplitBlocks(`Смотри:\n\n${broken}`);

    expect(scan.proposals).toHaveLength(0);
    expect(scan.text).toContain('это не json');
  });

  it('недописанный блок прячется целиком: в ленте не должно быть обрубка JSON', () => {
    const scan = scanSplitBlocks('Предлагаю разделить.\n\n```agentdeck:split\n{"groups":[{"ti');

    expect(scan.text).toBe('Предлагаю разделить.');
    expect(scan.proposals).toHaveLength(0);
  });

  it('одна группа — не разделение, предложением не считается', () => {
    expect(
      parseSplitProposal({ groups: [{ title: 'Одна', branch: 'a', tasks: ['x'] }] }),
    ).toBeUndefined();
  });

  it('группа без названия отбрасывается, а не заводит безымянный чат', () => {
    const parsed = parseSplitProposal({
      groups: [
        { branch: 'a', tasks: ['есть задача, но группа никак не названа'] },
        { title: 'Раз', branch: 'b', tasks: ['x'] },
        { title: 'Два', branch: 'c', tasks: ['y'] },
      ],
    });

    expect(parsed?.groups.map((group) => group.branch)).toEqual(['b', 'c']);
  });

  it('задание группы собирает общий контекст, памятку и нумерованный список', () => {
    const prompt = buildGroupPrompt(
      PROPOSAL.groups[1] as TaskSplitProposal['groups'][number],
      'Общее',
    );

    expect(prompt).toBe('Общее\n\n1. убрать лишний отступ\n2. выровнять');
  });

  it('единственную задачу не нумерует: это готовое задание, а не список', () => {
    const prompt = buildGroupPrompt({ title: 'Раз', branch: 'a', tasks: ['Сделай папку A'] });

    expect(prompt).toBe('Сделай папку A');
  });
});

/**
 * Формат блока придуман этой панелью — снаружи его не существует, «вспомнить»
 * его правильно модель не может и регулярно подменяет имена полей. Ровно это
 * случилось 1 сентября: предложение из пяти групп приехало с `files`/`prompt`
 * вместо `brief`/`tasks`, разбор отверг его целиком, и человек увидел в ленте
 * простыню JSON без единой кнопки. Каждый стенд ниже — форма, которую панель
 * обязана принять, не переставая при этом отбрасывать бессодержательное.
 */
describe('терпимость разбора к именам полей', () => {
  it('принимает форму, на которой панель споткнулась вживую: files + prompt', () => {
    const parsed = parseSplitProposal({
      shared: 'Общее для всех',
      groups: [
        { title: 'Папка A', files: ['a/**'], prompt: 'Создай папку A и положи в неё readme' },
        { title: 'Папка B', files: ['b/**'], prompt: 'Создай папку B и положи в неё readme' },
      ],
    });

    expect(parsed?.groups).toHaveLength(2);
    expect(parsed?.groups[0]?.tasks).toEqual(['Создай папку A и положи в неё readme']);
    expect(parsed?.groups[0]?.brief).toContain('a/**');
  });

  it('имя ветки выводит из названия группы, когда его не прислали', () => {
    const parsed = parseSplitProposal({
      groups: [
        { title: 'Форма входа', tasks: ['x'] },
        { title: 'Шапка сайта', tasks: ['y'] },
      ],
    });

    // Кириллица уезжает в путь каталога копии — в ветке её быть не должно.
    expect(parsed?.groups.map((group) => group.branch)).toEqual([
      'task/forma-vhoda',
      'task/shapka-sayta',
    ]);
  });

  it('название из одних символов не даёт пустую ветку', () => {
    const parsed = parseSplitProposal({
      groups: [
        { title: '???', tasks: ['x'] },
        { title: '!!!', tasks: ['y'] },
      ],
    });

    expect(parsed?.groups.map((group) => group.branch)).toEqual(['task/group-1', 'task/group-2']);
  });

  it('принимает синонимы: name вместо title, chats вместо groups, строку вместо списка', () => {
    const parsed = parseSplitProposal({
      chats: [
        { name: 'Раз', tasks: 'одна задача строкой' },
        { name: 'Два', items: ['первая', 'вторая'] },
      ],
    });

    expect(parsed?.groups.map((group) => group.title)).toEqual(['Раз', 'Два']);
    expect(parsed?.groups[0]?.tasks).toEqual(['одна задача строкой']);
    expect(parsed?.groups[1]?.tasks).toEqual(['первая', 'вторая']);
  });

  it('принимает вторую живую форму: shared списком, у группы только title и files', () => {
    // Ровно тот блок, на котором панель споткнулась 1 сентября в git-проекте:
    // `shared` пришёл пустым СПИСКОМ, а `tasks` модель не прислала вовсе —
    // смысл группы она сложила в заголовок.
    const parsed = parseSplitProposal({
      shared: [],
      groups: [
        { title: 'Документация: переписать README.md', files: ['README.md'] },
        { title: 'Тесты: завести src/index.test.js', files: ['src/index.test.js'] },
      ],
    });

    expect(parsed?.groups).toHaveLength(2);
    expect(parsed?.shared).toBeUndefined();
    // Название группы становится её единственной задачей: терять группу из-за
    // поля, которое человек и так читает в заголовке карточки, нельзя.
    expect(parsed?.groups[0]?.tasks).toEqual(['Документация: переписать README.md']);
    expect(parsed?.groups[1]?.brief).toBe('Границы группы: src/index.test.js');
  });

  it('shared списком строк склеивается в общий контекст, а не теряется', () => {
    const parsed = parseSplitProposal({
      shared: ['Проект на Node без сборки', 'Отступ — два пробела'],
      groups: [
        { title: 'Раз', tasks: ['x'] },
        { title: 'Два', tasks: ['y'] },
      ],
    });

    expect(parsed?.shared).toBe('Проект на Node без сборки\nОтступ — два пробела');
  });

  it('терпимость не превращает пустое в предложение', () => {
    expect(parseSplitProposal({ groups: [{ tasks: ['x'] }, { tasks: ['y'] }] })).toBeUndefined();
    expect(parseSplitProposal({ groups: [{ title: '   ' }, { title: 'Два' }] })).toBeUndefined();
    expect(parseSplitProposal({ groups: 'не список' })).toBeUndefined();
  });

  it('непонятый блок считается: без счётчика человек не отличит отказ панели от текста агента', () => {
    const scan = scanSplitBlocks('Вот:\n\n```agentdeck:split\n{"groups":[]}\n```');

    expect(scan.rejected).toBe(1);
    expect(scan.proposals).toHaveLength(0);
    expect(scan.text).toContain('"groups"');
  });

  it('разобранный блок в счётчик отказов не попадает', () => {
    expect(scanSplitBlocks(block(PROPOSAL)).rejected).toBe(0);
  });

  it('класс и назначение доезжают до группы, синонимы type и thinking — тоже', () => {
    const parsed = parseSplitProposal({
      groups: [
        { title: 'Раз', tasks: ['x'], kind: 'mechanical', model: 'sonnet', effort: 'medium' },
        { title: 'Два', tasks: ['y'], type: 'design', model: 'opus', thinking: 'high' },
        { title: 'Три', tasks: ['z'], class: 'tests' },
      ],
    });

    expect(parsed?.groups[0]).toMatchObject({
      kind: 'mechanical',
      model: 'sonnet',
      effort: 'medium',
    });
    expect(parsed?.groups[1]).toMatchObject({ kind: 'design', model: 'opus', effort: 'high' });
    expect(parsed?.groups[2]?.kind).toBe('tests');
  });

  /**
   * Проверять значения разбор не обязан: набор допустимых и потолок знает
   * клэмп (`contracts/model-cascade`), и он же уводит непонятое на потолок.
   * Обязан он другое — не терять группу из-за поля, которого мог и не быть.
   */
  it('мусор в назначении группу не отменяет', () => {
    const parsed = parseSplitProposal({
      groups: [
        { title: 'Раз', tasks: ['x'], model: 'gpt-5', effort: 'max' },
        { title: 'Два', tasks: ['y'], model: { name: 'sonnet' } },
      ],
    });

    expect(parsed?.groups).toHaveLength(2);
    expect(parsed?.groups[0]?.model).toBe('gpt-5');
    expect(parsed?.groups[1]?.model).toBeUndefined();
  });
});

// Выгрузка из трекера на 60–80 задач раскладывается и на 20 групп (группа —
// ветка и MR). Потолок в 8 резал хвост молча: ни агент, ни человек о нём не знали.
describe('потолки предложения', () => {
  const groups = (count: number, tasks = 1) =>
    Array.from({ length: count }, (_, index) => ({
      title: `Группа ${index + 1}`,
      tasks: Array.from({ length: tasks }, (_, task) => `GOR-${index * 100 + task}`),
    }));

  it('двадцать групп выгрузки заводятся все', () => {
    const parsed = parseSplitProposal({ groups: groups(20) });

    expect(parsed?.groups).toHaveLength(20);
    expect(parsed?.dropped).toBeUndefined();
  });

  it('сверх потолка — отброшенное названо числом, а не пропадает молча', () => {
    const parsed = parseSplitProposal({ groups: groups(SPLIT_MAX_GROUPS + 3) });

    expect(parsed?.groups).toHaveLength(SPLIT_MAX_GROUPS);
    expect(parsed?.dropped).toEqual({ groups: 3 });

    const long = parseSplitProposal({
      groups: [...groups(1, SPLIT_MAX_TASKS_PER_GROUP + 4), ...groups(1)],
    });
    expect(long?.groups[0]?.tasks).toHaveLength(SPLIT_MAX_TASKS_PER_GROUP);
    expect(long?.dropped).toEqual({ tasks: 4 });
  });

  it('потолок назван агенту в инструкции', () => {
    expect(SPLIT_SYSTEM_PROMPT).toContain(`Групп не больше ${SPLIT_MAX_GROUPS}`);
    expect(SPLIT_SYSTEM_PROMPT).not.toContain('\n');
  });
});

describe('имя ветки из заголовка модели', () => {
  it('пробелы и запрещённые символы становятся дефисами', () => {
    expect(safeBranchName('Правки формы входа')).toBe('Правки-формы-входа');
    expect(safeBranchName('feature/a~b^c:d')).toBe('feature/a-b-c-d');
  });

  it('точки и дефисы по краям сегментов срезаются — git такие имена не принимает', () => {
    expect(safeBranchName('.hidden/-name.')).toBe('hidden/name');
  });

  it('пустое имя не оставляет ветку без названия', () => {
    expect(safeBranchName('   ')).toBe('task');
  });

  /**
   * По этой же проверке карточка в ленте понимает, что предложение УЖЕ
   * разделено. Занятое имя разделение не отвергает, а дополняет суффиксом,
   * поэтому сверять «в лоб» нельзя: повторное нажатие искало бы среди имён,
   * которых само никогда не создаёт, ничего не находило и заводило копии заново.
   */
  it('заведённую ветку узнаёт и с суффиксом занятости', () => {
    expect(branchTaken('Правки формы входа', ['Правки-формы-входа'])).toBe(true);
    expect(branchTaken('feature/auth', ['feature/auth-2'])).toBe(true);
    expect(branchTaken('feature/auth', ['feature/auth-x'])).toBe(false);
    expect(branchTaken('feature/auth', ['feature/authorization'])).toBe(false);
    expect(branchTaken('feature/auth', [])).toBe(false);
  });
});

describe('разделение задач по чатам', () => {
  it('на каждую группу — своя копия, свой ключ чата и запущенный прогон', async () => {
    const git = fakeGit();
    const started: { chatId: string; cwd: string }[] = [];

    const result = await splitTasks({
      projectPath: '/repo',
      proposal: PROPOSAL,
      startRuns: true,
      git,
      now: () => 1000,
      start: ({ chatId, cwd }) => {
        started.push({ chatId, cwd });
        return true;
      },
    });

    expect(git.added).toEqual(['feature/login', 'feature/header']);
    expect(result.chats.map((chat) => chat.chatId)).toEqual(['new-1000-0', 'new-1000-1']);
    expect(result.chats.every((chat) => chat.started && chat.isWorktree)).toBe(true);
    expect(started.map((run) => run.cwd)).toEqual([
      '/copies/feature-login',
      '/copies/feature-header',
    ]);
    expect(result.failures).toHaveLength(0);
  });

  // Без доставки группа кончалась «готово» с незакоммиченной работой в копии, и
  // коммит, пуш и MR по каждой группе человек делал руками (23.09.2026).
  it('доставка включена — задание группы велит довести её до MR в ветке копии', async () => {
    const prompts: string[] = [];

    await splitTasks({
      projectPath: '/repo',
      proposal: PROPOSAL,
      startRuns: true,
      git: fakeGit({ takenBranches: async () => ['feature/login'] }),
      deliver: true,
      start: ({ prompt }) => {
        prompts.push(prompt);
        return true;
      },
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Доставка до готового MR');
    expect(prompts[0]).toContain('ticket-delivery');
    // Ветка — та, что завёл git, с суффиксом, а не имя из предложения.
    expect(prompts[0]).toContain('Ветку копии панель уже завела: feature/login-2.');
    // Задание группы при этом цело и идёт после преамбулы.
    expect(prompts[0]).toMatch(/Доставка до готового MR[\s\S]*починить валидацию/);
  });

  it('доставка выключена — задание как раньше, без слова о MR', async () => {
    const prompts: string[] = [];

    await splitTasks({
      projectPath: '/repo',
      proposal: PROPOSAL,
      startRuns: true,
      git: fakeGit(),
      start: ({ prompt }) => {
        prompts.push(prompt);
        return true;
      },
    });

    expect(prompts.some((prompt) => prompt.includes('Доставка до готового MR'))).toBe(false);
  });

  it('занятое имя ветки получает суффикс, а не отказ', async () => {
    const git = fakeGit({ takenBranches: async () => ['feature/login'] });

    const result = await splitTasks({
      projectPath: '/repo',
      proposal: PROPOSAL,
      startRuns: true,
      git,
      start: () => true,
    });

    expect(result.chats.map((chat) => chat.branch)).toEqual(['feature/login-2', 'feature/header']);
  });

  it('настоящее имя ветки называется ДО старта прогона — по нему группу ищет конец цепочки', async () => {
    const git = fakeGit({ takenBranches: async () => ['feature/login'] });
    const order: string[] = [];

    await splitTasks({
      projectPath: '/repo',
      proposal: PROPOSAL,
      startRuns: true,
      git,
      claimBranch: (index, branch) => order.push(`claim ${index} ${branch}`),
      start: ({ index, branch }) => {
        order.push(`start ${index} ${branch}`);
        return true;
      },
    });

    // Суффикс занятости приезжает учёту раньше, чем стартует прогон: между
    // этими двумя моментами цепочка группы успевает и начаться, и кончиться.
    expect(order).toEqual([
      'claim 0 feature/login-2',
      'claim 1 feature/header',
      'start 0 feature/login-2',
      'start 1 feature/header',
    ]);
  });

  it('сбой одной группы не откатывает остальные', async () => {
    const git = fakeGit({
      addWorktree: async (_dir, branch) => {
        if (branch === 'feature/login') throw new Error('каталог уже существует');
        return { path: `/copies/${branch}` };
      },
    });

    const result = await splitTasks({
      projectPath: '/repo',
      proposal: PROPOSAL,
      startRuns: true,
      git,
      start: () => true,
    });

    expect(result.chats).toHaveLength(1);
    expect(result.chats[0]?.title).toBe('Шапка');
    expect(result.failures[0]).toMatchObject({
      title: 'Форма входа',
      message: 'каталог уже существует',
    });
  });

  it('не репозиторий — чаты идут в том же каталоге, копий не заводится', async () => {
    const git = fakeGit({ isRepo: () => false });

    const result = await splitTasks({
      projectPath: '/plain',
      proposal: PROPOSAL,
      startRuns: true,
      git,
      start: () => true,
    });

    expect(git.added).toHaveLength(0);
    expect(result.chats.every((chat) => chat.path === '/plain' && !chat.isWorktree)).toBe(true);
  });

  it('«только завести чаты» — прогонов нет, но задание готово', async () => {
    let starts = 0;

    const result = await splitTasks({
      projectPath: '/repo',
      proposal: PROPOSAL,
      startRuns: false,
      git: fakeGit(),
      start: () => {
        starts += 1;
        return true;
      },
    });

    expect(starts).toBe(0);
    expect(result.chats.every((chat) => !chat.started)).toBe(true);
    expect(result.chats[0]?.prompt).toContain('починить валидацию');
  });

  it('провал подготовки копии не останавливает группу: хвост лога — в задании', async () => {
    const git = fakeGit({
      bootstrap: async (_dir, copy) =>
        copy.includes('login')
          ? {
              command: 'pnpm install',
              status: 'failed',
              startedAt: '2026-09-09T10:00:00.000Z',
              finishedAt: '2026-09-09T10:01:00.000Z',
              exitCode: 1,
              logTail: 'ERR_PNPM_OUTDATED_LOCKFILE',
            }
          : {
              command: 'pnpm install',
              status: 'ok',
              startedAt: '2026-09-09T10:00:00.000Z',
              finishedAt: '2026-09-09T10:01:00.000Z',
              exitCode: 0,
              logTail: 'Done',
            },
    });
    const prompts: string[] = [];

    const result = await splitTasks({
      projectPath: '/repo',
      proposal: PROPOSAL,
      startRuns: true,
      git,
      start: ({ prompt }) => {
        prompts.push(prompt);
        return true;
      },
    });

    expect(result.chats.every((chat) => chat.started)).toBe(true);
    expect(prompts[0]).toContain('⚠ Подготовка копии');
    expect(prompts[0]).toContain('кодом 1');
    expect(prompts[0]).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
    expect(prompts[0]).toContain('починить валидацию');
    // Провал — не «окружение готово» (Д13): зависимости могут отсутствовать.
    expect(prompts[0]).not.toContain('Окружение готово');
    // Удачная подготовка — в преамбуле как сделанное, без предупреждения.
    expect(prompts[1]).not.toContain('Подготовка копии');
    expect(prompts[1]).toContain('зависимости установлены');
    expect(prompts[1]).toContain('начинай сразу с задачи');
    expect(result.chats[0]?.prompt).toBe(prompts[0]);
  });

  it('задание копии открывает преамбула панели: зеркало, зависимости, откат lock-файлов', async () => {
    const git = fakeGit({
      addWorktree: async (_dir, branch) => ({
        path: `/copies/${branch}`,
        mirror: 'Локальный слой: перенесено 3',
      }),
      bootstrap: async () => ({
        command: 'pnpm install --frozen-lockfile',
        status: 'ok',
        startedAt: '2026-09-09T10:00:00.000Z',
        finishedAt: '2026-09-09T10:01:00.000Z',
        exitCode: 0,
        logTail: 'Done',
        reverted: ['pnpm-lock.yaml'],
      }),
    });
    const prompts: string[] = [];

    await splitTasks({
      projectPath: '/repo',
      proposal: PROPOSAL,
      startRuns: true,
      git,
      start: ({ prompt }) => {
        prompts.push(prompt);
        return true;
      },
    });

    const [first] = prompts;
    expect(first?.startsWith('Панель подготовила эту копию: Локальный слой: перенесено 3;')).toBe(
      true,
    );
    expect(first).toContain('зависимости установлены командой «pnpm install --frozen-lockfile»');
    expect(first).toContain('lock-файлы откачены: pnpm-lock.yaml');
    expect(first).toContain('Окружение готово — не проверяй и не настраивай');
    // Само задание — после преамбулы, целиком.
    const task = PROPOSAL.groups[0]?.tasks[0] ?? '';
    expect(task).not.toBe('');
    expect(first).toContain(task);
    expect(first?.indexOf('начинай сразу с задачи')).toBeLessThan(first?.indexOf(task) ?? -1);
  });

  it('подготовка не настроена — преамбула прямо говорит, что зависимости не ставились (Д13)', async () => {
    const prompts: string[] = [];

    await splitTasks({
      projectPath: '/repo',
      proposal: PROPOSAL,
      startRuns: true,
      git: fakeGit({}),
      start: ({ prompt }) => {
        prompts.push(prompt);
        return true;
      },
    });

    const [first] = prompts;
    // Так было в живом проекте: «готово» при пустых node_modules — и 5–10 минут
    // установки, дев-серверы и четыре переписанных lock-файла у детей.
    expect(first).not.toContain('Окружение готово');
    expect(first).toContain('Зависимости панель НЕ ставила');
    expect(first).toContain('без запуска дев-серверов');
    expect(first).toContain('lock-файлы');
  });

  it('группа в общем каталоге преамбулы не получает', async () => {
    const prompts: string[] = [];
    await splitTasks({
      projectPath: '/repo',
      proposal: PROPOSAL,
      startRuns: true,
      git: fakeGit({ isRepo: () => false }),
      start: ({ prompt }) => {
        prompts.push(prompt);
        return true;
      },
    });
    expect(prompts.every((prompt) => !prompt.includes('Панель'))).toBe(true);
  });

  it('подготовка копий идёт параллельно и ждётся до запуска', async () => {
    const order: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const git = fakeGit({
      bootstrap: async (_dir, copy) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        order.push(`boot:${copy}`);
        return undefined;
      },
    });

    await splitTasks({
      projectPath: '/repo',
      proposal: PROPOSAL,
      startRuns: true,
      git,
      start: ({ cwd }) => {
        order.push(`start:${cwd}`);
        return true;
      },
    });

    expect(peak).toBe(2);
    expect(order.slice(0, 2).every((item) => item.startsWith('boot:'))).toBe(true);
    expect(order.slice(2).every((item) => item.startsWith('start:'))).toBe(true);
  });

  it('отказ реестра (в этом чате уже идёт прогон) виден в ответе', async () => {
    const result = await splitTasks({
      projectPath: '/repo',
      proposal: PROPOSAL,
      startRuns: true,
      git: fakeGit(),
      start: () => false,
    });

    expect(result.chats.every((chat) => !chat.started)).toBe(true);
  });
});

/**
 * Порции конвейера уровней (Т1): заводится подмножество групп, чат стартует со
 * звена плана, копия отводится от ветки предшественника, и позиция группы едет
 * в ответ — по ней конвейер узнаёт свою запись.
 */
describe('порция групп для конвейера уровней', () => {
  it('заводит только выбранные группы, со стадией плана и контекстом, индекс — в ответе', async () => {
    const bases: (string | undefined)[] = [];
    const git = fakeGit({
      addWorktree: async (_dir, branch, base) => {
        bases.push(base);
        return { path: `/copies/${branch.replace(/\//g, '-')}` };
      },
    });
    const linked: { stage: string; index: number; base?: string }[] = [];
    const started: { stage: string; index: number; predecessors?: number }[] = [];
    const context = {
      base: 'feature/login',
      predecessors: [{ title: 'Форма входа', branch: 'feature/login' }],
    };

    const result = await splitTasks({
      projectPath: '/repo',
      proposal: PROPOSAL,
      startRuns: true,
      git,
      now: () => 1000,
      groups: [1, 7],
      stage: 'plan',
      context,
      link: (chat) =>
        void linked.push({
          stage: chat.stage,
          index: chat.index,
          ...(chat.context?.base ? { base: chat.context.base } : {}),
        }),
      start: (input) => {
        started.push({
          stage: input.stage,
          index: input.index,
          ...(input.context?.predecessors
            ? { predecessors: input.context.predecessors.length }
            : {}),
        });
        return true;
      },
    });

    // Копия одна — у выбранной группы, от ветки предшественника; чужой индекс отброшен.
    expect(bases).toEqual(['feature/login']);
    expect(result.chats.map((chat) => chat.branch)).toEqual(['feature/header']);
    expect(result.chats.map((chat) => [chat.index, chat.chatId])).toEqual([[1, 'new-1000-1']]);
    expect(linked).toEqual([{ stage: 'plan', index: 1, base: 'feature/login' }]);
    expect(started).toEqual([{ stage: 'plan', index: 1, predecessors: 1 }]);
  });

  it('сбой копии в порции называет позицию группы', async () => {
    const git = fakeGit({
      addWorktree: async () => {
        throw new Error('ветка занята');
      },
    });

    const result = await splitTasks({
      projectPath: '/repo',
      proposal: PROPOSAL,
      startRuns: true,
      git,
      groups: [1],
      start: () => true,
    });

    expect(result.failures).toEqual([
      { index: 1, title: 'Шапка', branch: 'feature/header', message: 'ветка занята' },
    ]);
  });
});

describe('ссылка на MR в блоке предложения', () => {
  const MR = 'https://gitlab.com/team/app/-/merge_requests/42';

  /** Разбор одной группы: всё остальное здесь неважно. */
  const groupOf = (extra: Record<string, unknown>) =>
    parseSplitProposal({
      groups: [{ title: 'Ревью MR', tasks: ['посмотри'], ...extra }],
    })?.groups[0];

  it('одна ревью-группа — законное предложение: обычная одиночка им не считается', () => {
    expect(groupOf({ review: MR })).toBeTruthy();
    expect(parseSplitProposal({ groups: [{ title: 'Одна', tasks: ['что-то'] }] })).toBeUndefined();
  });

  it('ссылка принимается и строкой, и объектом, и под именами mr/pr', () => {
    expect(groupOf({ review: MR })?.review).toEqual({ url: MR });
    expect(groupOf({ mr: { url: MR, source_branch: 'feature/login' } })?.review).toEqual({
      url: MR,
      branch: 'feature/login',
    });
    expect(groupOf({ pullRequest: { link: MR } })?.review).toEqual({ url: MR });
  });

  it('класс становится ревью сам: иначе проверка чужого кода уехала бы на модель слабее', () => {
    expect(groupOf({ review: MR })?.kind).toBe('review');
    // Названный агентом класс не трогаем: он мог знать про эту работу больше.
    expect(groupOf({ review: MR, kind: 'design' })?.kind).toBe('design');
  });

  it('не ссылка — не ревью: копию отводить не от чего', () => {
    for (const raw of ['посмотри MR Пети', 'file:///etc/passwd', '', { branch: 'main' }]) {
      expect(groupOf({ review: raw })?.review).toBeUndefined();
    }
  });
});

describe('группа ревью по ссылке', () => {
  const MR = 'https://gitlab.com/team/app/-/merge_requests/42';

  /** Предложение из одной ревью-группы: столько разделение и разрешает. */
  const REVIEW_PROPOSAL: TaskSplitProposal = {
    groups: [
      {
        title: 'Ревью MR 42',
        branch: 'review/mr-42',
        tasks: ['посмотри на обработку ошибок'],
        review: { url: MR },
      },
    ],
  };

  /** Один вызов со стендом по умолчанию: чем разделение отвечает и что запустило. */
  async function split(
    overrides: Partial<SplitTasksInput> & { git?: SplitGit & { added: string[] } },
    proposal: TaskSplitProposal = REVIEW_PROPOSAL,
  ) {
    const git = overrides.git ?? fakeGit();
    const started: { stage: string; prompt: string; cwd: string; review?: unknown }[] = [];
    const linked: { stage: string; review?: unknown }[] = [];

    const result = await splitTasks({
      projectPath: '/repo',
      proposal,
      startRuns: true,
      git,
      now: () => 1000,
      link: (chat) => void linked.push({ stage: chat.stage, review: chat.review }),
      start: (input) => {
        started.push({
          stage: input.stage,
          prompt: input.prompt,
          cwd: input.cwd,
          review: input.review,
        });
        return true;
      },
      ...overrides,
    });

    return { git, started, linked, result };
  }

  it('ветку MR берёт у форджа как есть — суффикса занятости она не получает', async () => {
    const asked: string[] = [];
    const { git, result, started } = await split({
      // Ветка уже заведена в репозитории: обычной группе досталось бы
      // `-2`, а ревью-группе такой суффикс дал бы ДРУГОЙ дифф.
      git: fakeGit({ takenBranches: async () => ['feature/very/long-branch-name'] }),
      resolveReview: async (review) => {
        asked.push(review.url);
        return { branch: 'feature/very/long-branch-name' };
      },
    });

    expect(asked).toEqual([MR]);
    expect(git.added).toEqual(['feature/very/long-branch-name']);
    expect(result.chats[0]?.branch).toBe('feature/very/long-branch-name');
    expect(started[0]?.review).toEqual({
      url: MR,
      branch: 'feature/very/long-branch-name',
      onMrBranch: true,
    });
  });

  it('без интеграции идёт ветка из блока агента, приведённая к имени git', async () => {
    const { git, started } = await split({}, {
      groups: [
        { ...REVIEW_PROPOSAL.groups[0], review: { url: MR, branch: 'feature/Вход в систему' } },
      ],
    } as TaskSplitProposal);

    expect(git.added).toEqual(['feature/Вход-в-систему']);
    expect(started[0]?.review).toMatchObject({ onMrBranch: true });
  });

  it('отказ форджа разделение не роняет, а задание честно говорит про базовую ветку', async () => {
    const { git, started, result } = await split({
      resolveReview: async () => {
        throw new Error('403');
      },
    });

    expect(result.failures).toHaveLength(0);
    // Ветки MR не знает никто — копия от базы под именем из блока.
    expect(git.added).toEqual(['review/mr-42']);
    expect(started[0]?.review).toEqual({ url: MR, onMrBranch: false });
    expect(started[0]?.prompt).toContain('отведена от базовой ветки');
  });

  it('задание — ревью MR, а не задание группы: править и писать в MR запрещено прямо', async () => {
    const { started } = await split({ resolveReview: async () => ({ branch: 'feature/login' }) });

    expect(started[0]?.prompt).toContain(MR);
    expect(started[0]?.prompt).toContain('deep-review');
    expect(started[0]?.prompt).toContain('НИЧЕГО НЕ ПРАВЬ');
    expect(started[0]?.prompt).toContain('посмотри на обработку ошибок');
    expect(started[0]?.prompt).toContain('agentdeck:review');
  });

  it('план ревью-группе не заводится: планировать нечего, она ничего не делает', async () => {
    const { started, linked } = await split({ stage: 'plan' });

    expect(started.map((run) => run.stage)).toEqual(['work']);
    expect(linked.map((chat) => chat.stage)).toEqual(['work']);
  });
});

describe('работа в нескольких MR', () => {
  const MR1 = 'https://gitlab.com/team/app/-/merge_requests/772';
  const MR2 = 'https://gitlab.com/team/app/-/merge_requests/773';

  it('два MR на работу — законное разделение, режим работы — явным action', () => {
    const proposal = parseSplitProposal({
      groups: [
        { title: '!772', tasks: ['реши конфликты'], review: { url: MR1, action: 'work' } },
        {
          title: '!773',
          tasks: ['поправь'],
          mr: { url: MR2 },
          action: 'work',
          kind: 'implementation',
        },
      ],
    });

    expect(proposal?.groups.map((group) => group.review)).toEqual([
      { url: MR1, work: true },
      { url: MR2, work: true },
    ]);
    // Класс «ревью» работе в MR не навязывается: иначе она ушла бы в режим чтения.
    expect(proposal?.groups[0]?.kind).toBeUndefined();
  });

  // Д1: веб шлёт на сервер уже разобранное предложение, сервер разбирает его
  // второй раз. Второй разбор терял `work`, и работа в MR уезжала ревью.
  it('повторный разбор ничего не теряет: parse(parse(x)) ≡ parse(x)', () => {
    const once = parseSplitProposal({
      shared: ['общий', 'контекст'],
      groups: [
        { title: '!772', tasks: ['реши конфликты'], review: { url: MR1, action: 'work' } },
        {
          title: '!773',
          tasks: ['поправь'],
          mr: { url: MR2, branch: 'feat/b' },
          action: 'work',
          kind: 'implementation',
          files: ['src/a.ts'],
        },
        { title: 'Ревью', tasks: ['посмотри'], review: MR2, model: 'opus', effort: 'high' },
      ],
    });

    const twice = parseSplitProposal(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
    expect(twice?.groups.map((group) => group.review?.work ?? false)).toEqual([true, true, false]);
    expect(twice?.groups.map((group) => group.kind)).toEqual([
      undefined,
      'implementation',
      'review',
    ]);
  });

  it('одна ссылка на работу — не разделение: это обычная работа в этом разговоре', () => {
    expect(
      parseSplitProposal({
        groups: [
          { title: '!772', tasks: ['реши конфликты'], review: { url: MR1, action: 'work' } },
        ],
      }),
    ).toBeUndefined();
  });

  it('группа работы в MR: копия на ветке MR, задание с правками, без ревью-связи', async () => {
    const git = fakeGit();
    const started: { stage: string; prompt: string; review?: unknown }[] = [];
    const linked: { review?: unknown }[] = [];

    await splitTasks({
      projectPath: '/repo',
      proposal: {
        groups: [
          {
            title: '!772',
            branch: 'x',
            tasks: ['реши конфликты с main'],
            review: { url: MR1, work: true },
          },
          { title: '!773', branch: 'y', tasks: ['посмотри'], review: { url: MR2 } },
        ],
      },
      startRuns: true,
      git,
      now: () => 1000,
      stage: 'plan',
      resolveReview: async (review) => ({
        branch: review.url.endsWith('772') ? 'feat/a' : 'feat/b',
      }),
      link: (chat) => void linked.push({ review: chat.review }),
      start: (input) => {
        started.push({ stage: input.stage, prompt: input.prompt, review: input.review });
        return true;
      },
    });

    expect(git.added).toEqual(['feat/a', 'feat/b']);
    const [work, review] = started;
    expect(work?.prompt).toContain(`работает в запросе на слияние ${MR1}`);
    expect(work?.prompt).toContain('реши конфликты с main');
    expect(work?.prompt).not.toContain('НИЧЕГО НЕ ПРАВЬ');
    // Работа идёт обычными стадиями и карточку решения по замечаниям не заводит.
    expect(work?.stage).toBe('plan');
    expect(work?.review).toBeUndefined();
    expect(linked[0]?.review).toBeUndefined();
    // Ревью соседнего MR — прежнее, только чтение.
    expect(review?.prompt).toContain('НИЧЕГО НЕ ПРАВЬ');
    expect(review?.review).toMatchObject({ url: MR2 });
  });
});
