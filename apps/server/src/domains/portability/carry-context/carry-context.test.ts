import { describe, it, expect } from 'vitest';
import { HANDOFF_MAX_CHAIN } from '@agentdeck/contracts/chat-handoff';
import type { CarryTargetFailure } from '@agentdeck/contracts/portable-carry';
import { HandoffChains } from '../../chat/ChatHandoff/ChatHandoff.ts';
import {
  carryChat,
  carryChats,
  planCarry,
  type CarryDeps,
  type CarrySourceChat,
} from './carry-context.ts';

/**
 * Перенос незакрытой работы к новому CLI (П6.1).
 *
 * Предохранители сюда не переписаны — их считает общий `evaluateHandoff`, и
 * проверяется здесь ровно то, что у переноса СВОЁ: кто попадает в список, что
 * исходный разговор остаётся нетронутым, что вторая попытка над той же
 * нетронутой работой отказывает, и что заметка в ленту источника не выдаётся за
 * сказанную, когда сказать было некуда.
 *
 * Память цепочек берётся настоящая (`HandoffChains` без диска): потолок,
 * наследование задания и отпечаток опоры — её работа, и подменять её значило бы
 * проверить заглушку вместо механизма.
 */

const CWD = 'C:/work/repo';
const NOW = 1_700_000_000_000;

function source(overrides: Partial<CarrySourceChat> = {}): CarrySourceChat {
  return {
    key: 'codex::work1',
    providerId: 'codex',
    providerName: 'Codex CLI',
    chatId: 'work1',
    title: 'Переименование · работа',
    cwd: CWD,
    updatedAt: NOW - 60_000,
    task: 'Переименуй foo в bar',
    ...overrides,
  };
}

function setup(
  options: {
    chains?: HandoffChains;
    hash?: string;
    mtime?: number | undefined;
    noticed?: boolean;
    /** Цель разговор не завела — и говорит, почему именно. */
    openFailure?: CarryTargetFailure;
  } = {},
): {
  deps: CarryDeps;
  chains: HandoffChains;
  opened: { cwd: string; prompt: string }[];
  notices: [string, string][];
} {
  const chains = options.chains ?? new HandoffChains();
  const opened: { cwd: string; prompt: string }[] = [];
  const notices: [string, string][] = [];
  const deps: CarryDeps = {
    chains,
    targetName: 'Claude Code',
    now: () => NOW,
    open: (input) => {
      opened.push(input);
      if (options.openFailure) return { ok: false, failure: options.openFailure };
      return { ok: true, key: `new-${opened.length}`, chatId: `new-${opened.length}` };
    },
    notice: (key, text) => {
      notices.push([key, text]);
      return options.noticed ?? true;
    },
    // Файловая система подменена целиком: предохранители смотрят на время и
    // отпечаток файла-опоры, и заводить его на диске ради этого незачем.
    stat: () => ('mtime' in options ? options.mtime : 5_000),
    hash: () => options.hash ?? 'sha-1',
  };
  return { deps, chains, opened, notices };
}

describe('planCarry', () => {
  it('берёт разговор с каталогом, тронутый внутри окна цепочек', () => {
    const { deps } = setup();

    const plan = planCarry([source()], deps);

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      key: 'codex::work1',
      providerId: 'codex',
      ready: true,
      chainDepth: 0,
      checkpoint: '.agent/PROGRESS.md',
    });
    expect(plan[0]?.reason).toBeUndefined();
  });

  it('выбрасывает разговор без рабочего каталога и разговор старше суток', () => {
    const { deps } = setup();

    const plan = planCarry(
      [
        source({ key: 'a', cwd: undefined }),
        source({ key: 'b', updatedAt: NOW - 25 * 60 * 60 * 1000 }),
        source({ key: 'c' }),
      ],
      deps,
    );

    expect(plan.map((candidate) => candidate.key)).toEqual(['c']);
  });

  it('оставляет в списке непригодный разговор и НАЗЫВАЕТ причину', () => {
    // Потолок цепочки: считает его `evaluateHandoff`, а не перенос.
    const chains = new HandoffChains();
    let from = 'root';
    for (let step = 0; step < HANDOFF_MAX_CHAIN; step += 1) {
      chains.link([from], `step${step}`);
      from = `step${step}`;
    }
    const { deps } = setup({ chains });

    const plan = planCarry([source({ key: from })], deps);

    expect(plan[0]?.ready).toBe(false);
    expect(plan[0]?.reason).toBe('chain_cap');
    expect(plan[0]?.chainDepth).toBe(HANDOFF_MAX_CHAIN);
  });

  it('без файла-опоры переносить не по чему — причина названа', () => {
    const { deps } = setup({ mtime: undefined });

    const plan = planCarry([source()], deps);

    expect(plan[0]).toMatchObject({ ready: false, reason: 'checkpoint_missing' });
  });

  it('свежие сверху', () => {
    const { deps } = setup();

    const plan = planCarry(
      [
        source({ key: 'старый', updatedAt: NOW - 3 * 60 * 60 * 1000 }),
        source({ key: 'свежий', updatedAt: NOW - 60_000 }),
      ],
      deps,
    );

    expect(plan.map((candidate) => candidate.key)).toEqual(['свежий', 'старый']);
  });
});

describe('carryChat', () => {
  it('заводит разговор у нового CLI с опорой и исходным заданием', async () => {
    const { deps, opened } = setup();

    const outcome = await carryChat(source(), deps);

    expect(outcome).toMatchObject({ carried: true, chatId: 'new-1', chainDepth: 1 });
    expect(opened).toHaveLength(1);
    expect(opened[0]?.cwd).toBe(CWD);
    expect(opened[0]?.prompt).toContain('.agent/PROGRESS.md');
    expect(opened[0]?.prompt).toContain('Переименуй foo в bar');
  });

  it('говорит в обе ленты и не обещает переезда переписки', async () => {
    const { deps, notices } = setup();

    await carryChat(source(), deps);

    const [target, origin] = notices;
    expect(target?.[0]).toBe('new-1');
    expect(target?.[1]).toContain('переписка не переносится');
    expect(origin?.[0]).toBe('codex::work1');
    expect(origin?.[1]).toContain('не закрыт и не изменён');
    expect(origin?.[1]).toContain(`перенос 1 из ${HANDOFF_MAX_CHAIN}`);
    // Имя продолжения — в заметке источника: по нему человек найдёт новый разговор.
    expect(origin?.[1]).toContain('«Переименование · работа · продолжение»');
  });

  it('заметка, которой некуда лечь, не выдаётся за сказанную', async () => {
    // Разговор Claude без живого прогона: лента — транскрипт самого CLI.
    const { deps } = setup({ noticed: false });

    expect((await carryChat(source(), deps)).noticedSource).toBe(false);
  });

  it('отказ цели назван, а не приезжает молчаливым «не перенесено»', async () => {
    // Беда цели одна — разговор у неё не пошёл (у чужого CLI это задача ядра): она
    // приезжает названной, а не молчаливым «не перенесено».
    for (const failure of ['run_not_started'] as const) {
      const { deps, notices } = setup({ openFailure: failure });

      const outcome = await carryChat(source(), deps);

      expect(outcome).toEqual({
        key: 'codex::work1',
        carried: false,
        failure,
        noticedSource: false,
      });
      // И ни одной заметки: перенос не состоялся, обещать его лентам нечем.
      expect(notices).toHaveLength(0);
    }
  });

  it('второй перенос той же нетронутой работы отказывает петлёй', async () => {
    const { deps, opened } = setup();

    expect((await carryChat(source(), deps)).carried).toBe(true);
    const second = await carryChat(source(), deps);

    expect(second).toMatchObject({ carried: false, reason: 'checkpoint_unchanged' });
    // Разговора у нового CLI не завели — второй попытки в хранилище нет.
    expect(opened).toHaveLength(1);
  });

  it('опора изменилась — переносить снова можно', async () => {
    const chains = new HandoffChains();
    const first = setup({ chains, hash: 'sha-1' });
    await carryChat(source(), first.deps);

    const second = setup({ chains, hash: 'sha-2' });
    expect((await carryChat(source(), second.deps)).carried).toBe(true);
  });

  it('разговор-продолжение уносит задание ЦЕПОЧКИ, а не свою первую реплику', async () => {
    // Исходное задание всей работы ставится первым продолжением и дальше
    // наследуется: перенос — такое же звено, и своё задание он не выдумывает.
    const chains = new HandoffChains();
    chains.link(['корень'], 'codex::work1', { rootTask: 'Разобрать модуль оплаты целиком' });
    const { deps, opened } = setup({ chains });

    await carryChat(source({ task: 'продолжай с тестов' }), deps);

    expect(opened[0]?.prompt).toContain('Разобрать модуль оплаты целиком');
    expect(opened[0]?.prompt).not.toContain('продолжай с тестов');
  });

  it('разговор без каталога не переносится', async () => {
    const { deps, opened } = setup();

    expect(await carryChat(source({ cwd: undefined }), deps)).toMatchObject({
      carried: false,
      reason: 'no_project',
    });
    expect(opened).toHaveLength(0);
  });
});

describe('carryChats', () => {
  it('отвечает по строке на каждый запрошенный ключ, в том же порядке', async () => {
    const { deps } = setup();

    const outcomes = await carryChats(
      [source({ key: 'a' }), source({ key: 'b' })],
      ['b', 'a'],
      deps,
    );

    expect(outcomes.map((outcome) => outcome.key)).toEqual(['b', 'a']);
    expect(outcomes.every((outcome) => outcome.carried)).toBe(true);
  });

  it('исчезнувший разговор — не отказ по причине, а отсутствие предмета', async () => {
    const { deps } = setup();

    const [outcome] = await carryChats([], ['ушёл'], deps);

    expect(outcome).toEqual({ key: 'ушёл', carried: false, noticedSource: false });
  });
});
