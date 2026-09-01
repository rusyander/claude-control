import { describe, it, expect } from 'vitest';
import {
  buildHandoffPrompt,
  HANDOFF_DEFAULT_CHECKPOINT,
  HANDOFF_MAX_CHAIN,
  parseHandoffProposal,
  scanHandoffBlocks,
  type HandoffProposal,
} from '@claude-control/contracts/chat-handoff';
import { evaluateHandoff, HandoffChains, startHandoff } from './ChatHandoff.ts';

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
  return ['```claude-control:handoff', JSON.stringify(json), '```'].join('\n');
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
    const text = '```claude-control:handoff\n{сломано}\n```';
    const scan = scanHandoffBlocks(text);
    expect(scan.proposals).toHaveLength(0);
    expect(scan.text).toContain('{сломано}');
  });

  it('недописанный блок прячется целиком, пока ответ печатается', () => {
    const scan = scanHandoffBlocks('Итог:\n\n```claude-control:handoff\n{"done":"эт');
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
    const scan = scanHandoffBlocks('Итог:\n\n```claude-control:handoff\n{"done":"этап"}\n```');

    expect(scan.rejected).toBe(1);
    expect(scan.proposals).toHaveLength(0);
    expect(scan.text).toContain('"done"');
  });

  it('разобранный блок в счётчик отказов не попадает', () => {
    expect(scanHandoffBlocks(block(PROPOSAL)).rejected).toBe(0);
  });

  it('недописанный блок отказом не считается — он ещё печатается', () => {
    expect(scanHandoffBlocks('```claude-control:handoff\n{"done":"эт').rejected).toBe(0);
  });
});

describe('первое сообщение новой сессии', () => {
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

  it('забытый разговор теряет и тумблер, и номер шага', () => {
    const chains = new HandoffChains();
    chains.setAuto(['sess-1'], true);
    chains.forget(['sess-1']);
    expect(chains.isAuto(['sess-1'])).toBe(false);
    expect(chains.depth(['sess-1'])).toBe(0);
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

describe('заведение продолжения', () => {
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
