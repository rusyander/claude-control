import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildHandoffPrompt,
  HANDOFF_DEFAULT_CHECKPOINT,
  HANDOFF_MAX_CHAIN,
  HANDOFF_ROOT_TASK_MAX,
  parseHandoffProposal,
  scanHandoffBlocks,
  scanHandoffProse,
  type HandoffProposal,
} from '@agentdeck/contracts/chat-handoff';
import {
  CHAIN_MAX_AGE_MS,
  evaluateHandoff,
  HandoffChains,
  HandoffChainStore,
  HANDOFF_CHAINS_FILE,
  startHandoff,
} from './ChatHandoff.ts';

/**
 * Продолжение работы в чистой сессии. Проверяем ровно то, чем эта штука может
 * навредить: что она соглашается стереть контекст только по свежему файлу-опоре,
 * что цепочка не крутится вечно и что тумблер действует в обоих написаниях ключа
 * разговора.
 */

const PROPOSAL: HandoffProposal = {
  done: 'Гейт зелёный, правки в рабочей копии',
  next: 'Продолжай по чекпойнту: остались документация и скриншоты',
  checkpoint: '.agent/PROGRESS.md',
};

function block(json: unknown): string {
  return ['```agentdeck:handoff', JSON.stringify(json), '```'].join('\n');
}

describe('разбор предложения', () => {
  it('берёт что закрыто и чем продолжить, чекпойнт по умолчанию', () => {
    const parsed = parseHandoffProposal({ done: 'этап', next: 'дальше' });
    expect(parsed).toEqual({
      done: 'этап',
      next: 'дальше',
      checkpoint: HANDOFF_DEFAULT_CHECKPOINT,
    });
  });

  it('без «чем продолжить» предложения нет: новой сессии нечего сказать', () => {
    expect(parseHandoffProposal({ done: 'этап' })).toBeUndefined();
    expect(parseHandoffProposal({ next: 'дальше' })).toBeUndefined();
    expect(parseHandoffProposal('не json')).toBeUndefined();
  });

  it.each([
    ['вверх по дереву', '../../secrets.md'],
    ['абсолютный путь', '/etc/passwd'],
    ['диск Windows', 'C:/Windows/System32/drivers/etc/hosts'],
  ])('чекпойнт наружу проекта не принимается (%s)', (_name, checkpoint) => {
    const parsed = parseHandoffProposal({ done: 'э', next: 'д', checkpoint });
    expect(parsed?.checkpoint).toBe(HANDOFF_DEFAULT_CHECKPOINT);
  });

  it('обратные слэши приводятся к прямым: модель пишет и так, и так', () => {
    const parsed = parseHandoffProposal({ done: 'э', next: 'д', checkpoint: '.agent\\STATE.md' });
    expect(parsed?.checkpoint).toBe('.agent/STATE.md');
  });
});

describe('вырезание блока из ответа', () => {
  it('закрытый блок уходит из показа, предложение остаётся', () => {
    const scan = scanHandoffBlocks(`Готово.\n\n${block(PROPOSAL)}\n\nДальше решай сам.`);
    expect(scan.text).toBe('Готово.\n\nДальше решай сам.');
    expect(scan.proposals).toHaveLength(1);
  });

  it('сломанный JSON остаётся в тексте: молча терять слова агента нельзя', () => {
    const text = '```agentdeck:handoff\n{сломано}\n```';
    const scan = scanHandoffBlocks(text);
    expect(scan.proposals).toHaveLength(0);
    expect(scan.text).toContain('{сломано}');
  });

  it('недописанный блок прячется целиком, пока ответ печатается', () => {
    const scan = scanHandoffBlocks('Итог:\n\n```agentdeck:handoff\n{"done":"эт');
    expect(scan.text).toBe('Итог:');
    expect(scan.proposals).toHaveLength(0);
  });

  it('действующим считается последнее предложение', () => {
    const first = { ...PROPOSAL, next: 'первое' };
    const second = { ...PROPOSAL, next: 'второе' };
    const scan = scanHandoffBlocks(`${block(first)}\n\n${block(second)}`);
    expect(scan.proposals.at(-1)?.next).toBe('второе');
  });

  /**
   * Счётчик отказов появился у разделения задач после живого разбора: непонятый
   * блок остаётся в ленте текстом, и без него человек видит простыню JSON без
   * единой кнопки и считает это поломкой панели. Передача этапа устроена ровно
   * так же и обязана считать отказы наравне.
   */
  it('непонятый блок считается: без счётчика человек не отличит отказ панели от текста агента', () => {
    // Блок закрыт и синтаксически верен, но без «чем продолжить» — продолжать
    // по нему нечем, поэтому предложением он не становится.
    const scan = scanHandoffBlocks('Итог:\n\n```agentdeck:handoff\n{"done":"этап"}\n```');

    expect(scan.rejected).toBe(1);
    expect(scan.proposals).toHaveLength(0);
    expect(scan.text).toContain('"done"');
  });

  it('разобранный блок в счётчик отказов не попадает', () => {
    expect(scanHandoffBlocks(block(PROPOSAL)).rejected).toBe(0);
  });

  it('недописанный блок отказом не считается — он ещё печатается', () => {
    expect(scanHandoffBlocks('```agentdeck:handoff\n{"done":"эт').rejected).toBe(0);
  });
});

/**
 * Проза вместо блока: скилл учит агента «назови /clear вслух», и он так и
 * пишет — раньше это был конец работы до утра. Проверяем, что фразы читаются,
 * что файл-опора берётся из текста, и что отрицание гасит всё.
 */
describe('просьба перезапуститься словами', () => {
  it.each([
    ['перезапустите сессию', 'Этап закрыт. Перезапустите сессию.'],
    ['перезапусти эту сессию', 'Готово, перезапусти эту сессию и продолжай.'],
    ['/clear', 'Задача закрыта — /clear, затем продолжай по PROGRESS.'],
    ['продолжай по', 'Дальше: продолжай по .agent/PROGRESS.md.'],
    ['новый прогон читает', 'Новый прогон читает .agent/PROGRESS.md и делает следующий шаг.'],
  ])('читается как предложение (%s)', (_name, text) => {
    const proposal = scanHandoffProse(text);
    expect(proposal).toBeDefined();
    expect(proposal?.checkpoint).toBe(HANDOFF_DEFAULT_CHECKPOINT);
    expect(proposal?.next).toContain(HANDOFF_DEFAULT_CHECKPOINT);
  });

  it('файл-опора берётся из текста, хвостовая пунктуация и кавычки срезаются', () => {
    expect(
      scanHandoffProse('Перезапустите сессию, новый прогон читает `.agent/STATE.md`.')?.checkpoint,
    ).toBe('.agent/STATE.md');
    expect(scanHandoffProse('продолжай по «.agent/notes/PROGRESS.md».')?.checkpoint).toBe(
      '.agent/notes/PROGRESS.md',
    );
  });

  it('файл-опора наружу проекта не принимается — берётся по умолчанию', () => {
    expect(scanHandoffProse('новый прогон читает ../../secrets.md')?.checkpoint).toBe(
      HANDOFF_DEFAULT_CHECKPOINT,
    );
  });

  it('отрицание гасит просьбу: «не перезапускай» — продолжаем здесь', () => {
    expect(scanHandoffProse('Не перезапускай сессию, я ещё не закончил.')).toBeUndefined();
    expect(
      scanHandoffProse('Сессию не нужно перезапускать — продолжай по .agent/PROGRESS.md'),
    ).toBeUndefined();
  });

  it('обычный ответ без этих фраз — не предложение', () => {
    expect(scanHandoffProse('Сделал. Тесты зелёные, продолжай по плану.')).toBeUndefined();
    expect(scanHandoffProse('Команда clear в терминале чистит экран.')).toBeUndefined();
  });

  it('смотрится только хвост ответа: «/clear» в начале длинного разбора — разговор о команде', () => {
    const long = '/clear недоступен хукам.\n' + 'x'.repeat(2000) + '\nГотово.';
    expect(scanHandoffProse(long)).toBeUndefined();
  });
});

describe('первое сообщение новой сессии', () => {
  it('исходное задание едет последним и обрезается по потолку', () => {
    const prompt = buildHandoffPrompt(PROPOSAL, 'Сделай экспорт отчётов. '.repeat(1000));
    expect(prompt).toContain('Исходное задание');
    expect(prompt.indexOf('Исходное задание')).toBeGreaterThan(prompt.indexOf(PROPOSAL.next));
    expect(prompt.length).toBeLessThan(HANDOFF_ROOT_TASK_MAX + 600);
  });

  it('без исходного задания строки о нём нет', () => {
    expect(buildHandoffPrompt(PROPOSAL)).not.toContain('Исходное задание');
  });

  it('предупреждает о потере контекста и называет файл-опору', () => {
    const prompt = buildHandoffPrompt(PROPOSAL);
    expect(prompt).toContain('новая сессия');
    expect(prompt).toContain('.agent/PROGRESS.md');
    expect(prompt).toContain(PROPOSAL.next);
  });
});

describe('цепочки', () => {
  it('тумблер действует в обоих написаниях ключа разговора', () => {
    const chains = new HandoffChains();
    chains.setAuto(['new-1', 'sess-1'], true);
    expect(chains.isAuto(['sess-1'])).toBe(true);
    expect(chains.isAuto(['new-1'])).toBe(true);
    expect(chains.isAuto(['чужой'])).toBe(false);
  });

  it('продолжение наследует тумблер и получает следующий номер шага', () => {
    const chains = new HandoffChains();
    chains.setAuto(['sess-1'], true);
    expect(chains.link(['sess-1'], 'new-2')).toBe(1);
    expect(chains.isAuto(['new-2'])).toBe(true);
    expect(chains.link(['new-2'], 'new-3')).toBe(2);
  });

  it('без включённого тумблера цепочка не наследует автомат', () => {
    const chains = new HandoffChains();
    expect(chains.link(['sess-1'], 'new-2')).toBe(1);
    expect(chains.isAuto(['new-2'])).toBe(false);
  });

  it('звено конвейера наследует всё, но шаг не двигает', () => {
    const chains = new HandoffChains();
    chains.setAuto(['sess-1'], true);
    expect(chains.link(['sess-1'], 'new-2', { rootTask: 'задание', checkpointHash: 'h1' })).toBe(1);
    expect(chains.link(['new-2'], 'review-3', { stage: true })).toBe(1);
    expect(chains.isAuto(['review-3'])).toBe(true);
    expect(chains.rootTaskOf(['review-3'])).toBe('задание');
    expect(chains.lastCheckpointHash(['review-3'])).toBe('h1');
    // Следующее продолжение после звена — шаг 2, а не 3.
    expect(chains.link(['review-3'], 'new-4', { checkpointHash: 'h2' })).toBe(2);
    expect(chains.lastCheckpointHash(['new-4'])).toBe('h2');
  });

  it('исходное задание ставится первым продолжением и дальше не перебивается', () => {
    const chains = new HandoffChains();
    chains.link(['sess-1'], 'new-2', { rootTask: 'первое' });
    chains.link(['new-2'], 'new-3', { rootTask: 'второе' });
    expect(chains.rootTaskOf(['new-3'])).toBe('первое');
    expect(chains.rootTaskOf(['sess-1'])).toBeUndefined();
  });

  it('забытый разговор теряет и тумблер, и номер шага', () => {
    const chains = new HandoffChains();
    chains.setAuto(['sess-1'], true);
    chains.forget(['sess-1']);
    expect(chains.isAuto(['sess-1'])).toBe(false);
    expect(chains.depth(['sess-1'])).toBe(0);
  });
});

/**
 * Настройка «продолжать во всех разговорах» — это ЗНАЧЕНИЕ ПО УМОЛЧАНИЮ, а не
 * приказ: тумблер, тронутый руками, сильнее её в обе стороны. Проверяем именно
 * это, потому что перепутать легко, а цена ошибки — стёртый контекст в
 * разговоре, где человек автомат сознательно выключил.
 */
describe('глобальное «продолжать самой»', () => {
  it('нетронутый разговор продолжает сам, когда настройка включена', () => {
    const chains = new HandoffChains(() => true);
    expect(chains.isAuto(['sess-1'])).toBe(true);
  });

  it('выключенный руками остаётся выключенным', () => {
    const chains = new HandoffChains(() => true);
    chains.setAuto(['sess-1'], false);
    expect(chains.isAuto(['sess-1'])).toBe(false);
  });

  it('включённый руками работает и при выключенной настройке', () => {
    const chains = new HandoffChains(() => false);
    chains.setAuto(['sess-1'], true);
    expect(chains.isAuto(['sess-1'])).toBe(true);
  });

  it('настройка читается на каждый вопрос: её меняют при живом сервере', () => {
    let global = false;
    const chains = new HandoffChains(() => global);
    expect(chains.isAuto(['sess-1'])).toBe(false);
    global = true;
    expect(chains.isAuto(['sess-1'])).toBe(true);
  });

  /**
   * Разговор попадает в память цепочек и до всякого тумблера — на первом же
   * рассказе о размере окна. Если бы этот путь записывал «выключено», разговор
   * навсегда выпадал бы из глобальной настройки, и понять почему было бы нечем.
   */
  it('рассказ о размере окна не отменяет глобальную настройку', () => {
    const chains = new HandoffChains(() => true);
    chains.shouldNoticeContext(['sess-1'], 150_000);
    expect(chains.isAuto(['sess-1'])).toBe(true);
  });

  it('продолжение нетронутого разговора тоже следует за настройкой', () => {
    let global = true;
    const chains = new HandoffChains(() => global);
    chains.link(['sess-1'], 'new-2');
    expect(chains.isAuto(['new-2'])).toBe(true);
    global = false;
    expect(chains.isAuto(['new-2'])).toBe(false);
  });

  it('выключенный руками не оживает в продолжении', () => {
    const chains = new HandoffChains(() => true);
    chains.setAuto(['sess-1'], false);
    chains.link(['sess-1'], 'new-2');
    expect(chains.isAuto(['new-2'])).toBe(false);
  });
});

describe('предохранители автопродолжения', () => {
  const base = {
    proposal: PROPOSAL,
    cwd: 'C:/work/проект',
    ok: true,
    startedAt: 1_000,
    auto: true,
    depth: 0,
    stat: () => 2_000,
  };

  it('пропускает, когда файл-опора записан этим прогоном', () => {
    expect(evaluateHandoff(base)).toEqual({ ok: true, proposal: PROPOSAL });
  });

  it('блока нет — обычное завершение хода, молчим', () => {
    const verdict = evaluateHandoff({ ...base, proposal: undefined });
    expect(verdict).toEqual({ ok: false, reason: 'no_block' });
  });

  it('автомат выключен — предложение возвращается для карточки', () => {
    const verdict = evaluateHandoff({ ...base, auto: false });
    expect(verdict).toMatchObject({ ok: false, reason: 'auto_off', proposal: PROPOSAL });
  });

  it('после ошибки прогона не продолжаем: там осталась работа', () => {
    expect(evaluateHandoff({ ...base, ok: false })).toMatchObject({ reason: 'run_failed' });
  });

  it('разговор вне проекта продолжать негде', () => {
    expect(evaluateHandoff({ ...base, cwd: undefined })).toMatchObject({ reason: 'no_project' });
  });

  it('потолок цепочки останавливает ночной самозапуск', () => {
    expect(evaluateHandoff({ ...base, depth: HANDOFF_MAX_CHAIN })).toMatchObject({
      reason: 'chain_cap',
    });
  });

  it('файла-опоры нет — продолжать не по чему', () => {
    expect(evaluateHandoff({ ...base, stat: () => undefined })).toMatchObject({
      reason: 'checkpoint_missing',
    });
  });

  it('файл-опора старше прогона — контекст стёрся бы впустую', () => {
    expect(evaluateHandoff({ ...base, stat: () => 999 })).toMatchObject({
      reason: 'checkpoint_stale',
    });
  });

  it('файл, записанный ровно в момент старта, считается свежим', () => {
    expect(evaluateHandoff({ ...base, stat: () => 1_000 }).ok).toBe(true);
  });

  it('чекпойнт вне каталога разговора не проверяется, а отвергается', () => {
    const verdict = evaluateHandoff({
      ...base,
      // Такое не пройдёт разбор блока, но маршрут принимает предложение и от
      // телефона: проверка каталога обязана стоять и здесь, у файловой системы.
      proposal: { ...PROPOSAL, checkpoint: '../соседний/PROGRESS.md' },
      stat: () => 2_000,
    });
    expect(verdict).toMatchObject({ reason: 'checkpoint_missing' });
  });
});

describe('предохранитель «чекпойнт не изменился»', () => {
  const base = {
    proposal: PROPOSAL,
    cwd: 'C:/work/проект',
    ok: true,
    startedAt: 1_000,
    auto: true,
    depth: 1,
    stat: () => 2_000,
  };

  it('тот же отпечаток, что при прошлом продолжении, — отказ', () => {
    const verdict = evaluateHandoff({ ...base, previousHash: 'abc', hash: () => 'abc' });
    expect(verdict).toEqual({ ok: false, reason: 'checkpoint_unchanged', proposal: PROPOSAL });
  });

  it('файл изменился — продолжаем', () => {
    expect(evaluateHandoff({ ...base, previousHash: 'abc', hash: () => 'def' }).ok).toBe(true);
  });

  it('у первого продолжения сравнивать не с чем — продолжаем', () => {
    expect(evaluateHandoff({ ...base, hash: () => 'abc' }).ok).toBe(true);
  });

  it('потолок считается продолжениями: восьмое — последнее', () => {
    expect(evaluateHandoff({ ...base, depth: HANDOFF_MAX_CHAIN - 1 }).ok).toBe(true);
    expect(evaluateHandoff({ ...base, depth: HANDOFF_MAX_CHAIN })).toMatchObject({
      ok: false,
      reason: 'chain_cap',
    });
  });
});

describe('заведение продолжения', () => {
  it('исходное задание уезжает в промпт и запоминается цепочкой', () => {
    const chains = new HandoffChains();
    const started = startHandoff({
      proposal: PROPOSAL,
      cwd: 'C:/work/проект',
      fromAliases: ['sess-1'],
      chains,
      startRun: false,
      start: () => true,
      rootTask: 'Сделай экспорт отчётов',
      checkpointHash: 'h1',
    });
    expect(started.prompt).toContain('Сделай экспорт отчётов');
    expect(chains.rootTaskOf([started.chatId])).toBe('Сделай экспорт отчётов');
    expect(chains.lastCheckpointHash([started.chatId])).toBe('h1');

    // Второе продолжение: своё задание у цепочки уже есть, новое не перебивает.
    const second = startHandoff({
      proposal: PROPOSAL,
      cwd: 'C:/work/проект',
      fromAliases: [started.chatId],
      chains,
      startRun: false,
      start: () => true,
      rootTask: 'другое',
    });
    expect(second.prompt).toContain('Сделай экспорт отчётов');
    expect(second.prompt).not.toContain('другое');
    expect(second.chainDepth).toBe(2);
  });

  it('запускает прогон в том же каталоге и наращивает цепочку', () => {
    const chains = new HandoffChains();
    chains.setAuto(['sess-1'], true);
    const started: { chatId: string; prompt: string; cwd: string }[] = [];

    const result = startHandoff({
      proposal: PROPOSAL,
      cwd: 'C:/work/проект',
      fromAliases: ['sess-1'],
      chains,
      startRun: true,
      start: (input) => {
        started.push(input);
        return true;
      },
      now: () => 42,
    });

    expect(result).toMatchObject({
      chatId: 'new-42',
      path: 'C:/work/проект',
      started: true,
      chainDepth: 1,
    });
    expect(started).toHaveLength(1);
    expect(started[0]?.cwd).toBe('C:/work/проект');
    // Новый разговор унаследовал автомат — иначе цепочка обрывалась бы на первом
    // же переходе, а человек включал её именно ради продолжения.
    expect(chains.isAuto(['new-42'])).toBe(true);
  });

  it('без запуска прогона отдаёт готовое задание для поля ввода', () => {
    const result = startHandoff({
      proposal: PROPOSAL,
      cwd: 'C:/work/проект',
      fromAliases: [],
      chains: new HandoffChains(),
      startRun: false,
      start: () => {
        throw new Error('прогон запускать не просили');
      },
      now: () => 7,
    });

    expect(result.started).toBe(false);
    expect(result.prompt).toContain(PROPOSAL.next);
  });
});

/**
 * Цепочки переживают перезапуск панели.
 *
 * Прогоны его переживают с тех пор, как их усыновляют из журнала, а стенд
 * поднимает `keepalive`; цепочка же начинала счёт заново — потолок в восемь
 * продолжений обнулялся, а отпечаток файла-опоры терялся, и предохранитель
 * «агент ходит по кругу» пропускал лишний круг. Проверяем на НАСТОЯЩЕМ файле:
 * подменённое хранилище доказало бы карту в памяти, а не то, что панель
 * поднимает цепочку со старта.
 */
describe('HandoffChains на диске', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-chains-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const boot = (): HandoffChains => new HandoffChains(() => false, new HandoffChainStore(dir));

  it('номер шага, задание и отпечаток чекпойнта поднимаются после перезапуска', () => {
    const before = boot();
    before.setAuto(['new-1', 'sess-1'], true);
    const depth = before.link(['new-1', 'sess-1'], 'new-2', {
      rootTask: 'Собери отчёт',
      checkpointHash: 'abc123',
    });
    expect(depth).toBe(1);
    expect(existsSync(join(dir, HANDOFF_CHAINS_FILE))).toBe(true);

    // Тот же каталог, новый объект — это и есть перезапуск сервера.
    const after = boot();
    expect(after.depth(['new-2'])).toBe(1);
    expect(after.isAuto(['sess-1'])).toBe(true);
    expect(after.rootTaskOf(['new-2'])).toBe('Собери отчёт');
    expect(after.lastCheckpointHash(['new-2'])).toBe('abc123');
    // Псевдонимы остались одним состоянием: шаг по одному ключу виден по другому.
    after.setAuto(['new-1'], false);
    expect(after.isAuto(['sess-1'])).toBe(false);
  });

  it('предохранитель «чекпойнт не изменился» держится через перезапуск', () => {
    const before = boot();
    before.link(['new-1'], 'new-2', { checkpointHash: 'same-hash' });

    const after = boot();
    const verdict = evaluateHandoff({
      proposal: PROPOSAL,
      cwd: 'C:/work/проект',
      ok: true,
      startedAt: 1_000,
      auto: true,
      depth: after.depth(['new-2']),
      ...(after.lastCheckpointHash(['new-2']) !== undefined
        ? { previousHash: after.lastCheckpointHash(['new-2']) as string }
        : {}),
      stat: () => 2_000,
      hash: () => 'same-hash',
    });

    // До этой правки после перезапуска отпечатка не было, и круг заводился снова.
    expect(verdict).toEqual({ ok: false, reason: 'checkpoint_unchanged', proposal: PROPOSAL });
  });

  it('цепочка старше суток не поднимается: потолок не держит вчерашнюю работу', () => {
    writeFileSync(
      join(dir, HANDOFF_CHAINS_FILE),
      JSON.stringify([
        { aliases: ['old'], depth: 7, touchedAt: Date.now() - CHAIN_MAX_AGE_MS - 1_000 },
        { aliases: ['fresh'], depth: 3, touchedAt: Date.now() - 1_000 },
      ]),
      'utf8',
    );

    const chains = boot();
    expect(chains.depth(['old'])).toBe(0);
    expect(chains.depth(['fresh'])).toBe(3);
  });

  it('битый файл — пустая память, а не падение старта', () => {
    writeFileSync(join(dir, HANDOFF_CHAINS_FILE), '{не json', 'utf8');
    expect(() => boot()).not.toThrow();
    expect(boot().depth(['что угодно'])).toBe(0);
  });

  it('«забыть цепочку» стирает её и на диске', () => {
    const before = boot();
    before.link(['new-1'], 'new-2', { checkpointHash: 'hash' });
    before.forget(['new-2']);

    expect(boot().lastCheckpointHash(['new-2'])).toBeUndefined();
  });
});
