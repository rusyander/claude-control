import { describe, it, expect } from 'vitest';
import {
  branchTaken,
  buildGroupPrompt,
  parseSplitProposal,
  safeBranchName,
  scanSplitBlocks,
  type TaskSplitProposal,
} from '@claude-control/contracts/task-split';
import { splitTasks, type SplitGit } from './ChatSplit.ts';

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
  return ['```claude-control:split', JSON.stringify(json), '```'].join('\n');
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
      return `/copies/${branch.replace(/\//g, '-')}`;
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
    const broken = '```claude-control:split\n{ это не json }\n```';
    const scan = scanSplitBlocks(`Смотри:\n\n${broken}`);

    expect(scan.proposals).toHaveLength(0);
    expect(scan.text).toContain('это не json');
  });

  it('недописанный блок прячется целиком: в ленте не должно быть обрубка JSON', () => {
    const scan = scanSplitBlocks(
      'Предлагаю разделить.\n\n```claude-control:split\n{"groups":[{"ti',
    );

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
    const scan = scanSplitBlocks('Вот:\n\n```claude-control:split\n{"groups":[]}\n```');

    expect(scan.rejected).toBe(1);
    expect(scan.proposals).toHaveLength(0);
    expect(scan.text).toContain('"groups"');
  });

  it('разобранный блок в счётчик отказов не попадает', () => {
    expect(scanSplitBlocks(block(PROPOSAL)).rejected).toBe(0);
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

  it('сбой одной группы не откатывает остальные', async () => {
    const git = fakeGit({
      addWorktree: async (_dir, branch) => {
        if (branch === 'feature/login') throw new Error('каталог уже существует');
        return `/copies/${branch}`;
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
