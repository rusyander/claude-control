import { describe, it, expect, vi } from 'vitest';
import { HANDOFF_BLOCK_LANG, HANDOFF_MAX_CHAIN } from '@agentdeck/contracts/chat-handoff';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import { HandoffChains } from '../chat/ChatHandoff.ts';
import {
  continuationTitle,
  planForeignHandoff,
  refusalNotice,
  type ForeignHandoffDeps,
  type ForeignHandoffInput,
} from './handoff.ts';

/**
 * Продолжение работы в новом разговоре у чужого CLI.
 *
 * Предохранители сюда не переписаны — их считает общий `evaluateHandoff`, и
 * проверяется здесь ровно то, что у чужого провайдера СВОЁ: разговор заводится
 * хранилищем (идентификатор выдаёт оно, а не панель), назначение и связь
 * переезжают целиком, а человеку сказано, что сессии у CLI нет.
 */

const CWD = 'C:/work/repo';
const CHECKPOINT = '.agent/PROGRESS.md';

function handoffBlock(): string {
  return [
    'Этап закрыт.',
    '',
    '```' + HANDOFF_BLOCK_LANG,
    JSON.stringify({
      done: 'Разобрал модуль',
      next: 'Продолжай с тестов',
      checkpoint: CHECKPOINT,
    }),
    '```',
  ].join('\n');
}

function setup(
  options: {
    chains?: HandoffChains;
    mtime?: number;
    hash?: string;
    open?: (input: { title: string }) => string | undefined;
  } = {},
): {
  deps: ForeignHandoffDeps;
  chains: HandoffChains;
  opened: { title: string; cwd: string; model?: string }[];
  runs: { chatId: string; prompt: string }[];
  links: [string, ChatLink][];
} {
  const chains = options.chains ?? new HandoffChains(() => true);
  const opened: { title: string; cwd: string; model?: string }[] = [];
  const runs: { chatId: string; prompt: string }[] = [];
  const links: [string, ChatLink][] = [];
  const deps: ForeignHandoffDeps = {
    chains,
    open: (input) => {
      opened.push(input);
      return options.open ? options.open(input) : `c${opened.length}`;
    },
    run: (chatId, prompt) => {
      runs.push({ chatId, prompt });
    },
    saveLink: (key, link) => {
      links.push([key, link]);
    },
    // Файловая система подменена целиком: предохранители смотрят на время и
    // отпечаток файла-опоры, а заводить его на диске ради этого незачем.
    stat: () => options.mtime ?? 5_000,
    hash: () => options.hash ?? 'sha-new',
  };
  return { deps, chains, opened, runs, links };
}

function input(overrides: Partial<ForeignHandoffInput> = {}): ForeignHandoffInput {
  return {
    providerId: 'codex',
    chatId: 'work1',
    ok: true,
    text: handoffBlock(),
    startedAt: 1_000,
    cwd: CWD,
    title: 'Переименование · работа',
    task: 'Переименуй foo в bar',
    ...overrides,
  };
}

describe('planForeignHandoff', () => {
  it('заводит продолжение новым разговором в том же каталоге и запускает его', () => {
    const { deps, opened, runs } = setup();

    const outcome = planForeignHandoff(input(), deps);

    expect(outcome?.chatId).toBe('c1');
    expect(opened).toEqual([{ title: 'Переименование · работа · продолжение', cwd: CWD }]);
    expect(runs).toHaveLength(1);
    // Задание продолжения — предложение агента ПЛЮС исходная задача цепочки:
    // третья сессия подряд обязана всё ещё знать границы своей работы.
    expect(runs[0]?.prompt).toContain('Продолжай с тестов');
    expect(runs[0]?.prompt).toContain('Переименуй foo в bar');
  });

  it('говорит человеку, что сессии у CLI нет, а не «продолжили с того же места»', () => {
    const { deps } = setup();

    const outcome = planForeignHandoff(input(), deps);

    expect(outcome?.notice).toContain('сессии у CLI нет');
    expect(outcome?.notice).toContain('продолжение 1');
  });

  it('переносит назначение и связь: продолжение остаётся тем же звеном той же группы', () => {
    const { deps, opened, links } = setup();
    const link: ChatLink = {
      parentChatId: 'codex:parent',
      title: 'Переименование',
      branch: 'split/rename',
      stage: 'work',
      createdAt: '2026-09-09T10:00:00.000Z',
    };

    planForeignHandoff(
      input({
        model: 'gpt-5.3-codex-spark',
        effort: 'medium',
        cascade: { stage: 'work', group: 'Переименование', lowered: true },
        link,
      }),
      deps,
    );

    expect(opened[0]?.model).toBe('gpt-5.3-codex-spark');
    expect(links).toHaveLength(1);
    expect(links[0]?.[0]).toBe('codex:c1');
    expect(links[0]?.[1]).toMatchObject({ parentChatId: 'codex:parent', stage: 'work' });
  });

  it('проза вместо блока — то же предложение и те же предохранители', () => {
    const { deps, runs } = setup();

    const outcome = planForeignHandoff(
      input({ text: 'Готово. Перезапустите сессию и продолжайте по .agent/PROGRESS.md.' }),
      deps,
    );

    expect(outcome?.chatId).toBe('c1');
    expect(runs[0]?.prompt).toContain('.agent/PROGRESS.md');
  });

  it('автомат выключен — молчит: карточка блока в ленте и так есть', () => {
    const { deps, runs } = setup({ chains: new HandoffChains(() => false) });

    expect(planForeignHandoff(input(), deps)).toBeUndefined();
    expect(runs).toHaveLength(0);
  });

  it('блока и прозы нет — обычный конец хода, без заметок', () => {
    const { deps, runs } = setup();

    expect(planForeignHandoff(input({ text: 'Сделал, вопросов нет.' }), deps)).toBeUndefined();
    expect(runs).toHaveLength(0);
  });

  it('потолок цепочки останавливает ночную карусель и говорит об этом', () => {
    const chains = new HandoffChains(() => true);
    // Восемь продолжений подряд уже сделаны: девятого не будет.
    let previous = 'codex:root';
    for (let step = 0; step < HANDOFF_MAX_CHAIN; step += 1) {
      chains.link([previous], `codex:step${step}`);
      previous = `codex:step${step}`;
    }
    const { deps, runs } = setup({ chains });

    const outcome = planForeignHandoff(input({ chatId: 'step7' }), deps);

    expect(outcome?.reason).toBe('chain_cap');
    expect(outcome?.notice).toContain('цепочка остановлена');
    expect(runs).toHaveLength(0);
  });

  it('файл-опора слово в слово прежний — круг, и цепочка встаёт', () => {
    const chains = new HandoffChains(() => true);
    chains.link(['codex:root'], 'codex:work1', { checkpointHash: 'sha-same' });
    const { deps, runs } = setup({ chains, hash: 'sha-same' });

    const outcome = planForeignHandoff(input(), deps);

    expect(outcome?.reason).toBe('checkpoint_unchanged');
    expect(outcome?.notice).toContain('по кругу');
    expect(runs).toHaveLength(0);
  });

  it('файл-опора не обновлён в этом прогоне — продолжать не по чему', () => {
    const { deps, runs } = setup({ mtime: 500 });

    const outcome = planForeignHandoff(input({ startedAt: 1_000 }), deps);

    expect(outcome?.reason).toBe('checkpoint_stale');
    expect(runs).toHaveLength(0);
  });

  it('провалившийся прогон не продолжают: там осталась работа, а не результат', () => {
    const { deps, runs } = setup();

    expect(planForeignHandoff(input({ ok: false }), deps)?.reason).toBe('run_failed');
    expect(runs).toHaveLength(0);
  });

  it('без рабочего каталога заводить продолжение негде', () => {
    const { deps, runs } = setup();

    const outcome = planForeignHandoff(input({ cwd: undefined }), deps);

    expect(outcome?.reason).toBe('no_project');
    expect(runs).toHaveLength(0);
  });

  it('дерево на паузе: разговор заведён, запуск в очереди', () => {
    const { deps, opened, runs } = setup();
    const defer = vi.fn().mockReturnValue(true);

    const outcome = planForeignHandoff(input(), { ...deps, gate: { defer } as never });

    expect(opened).toHaveLength(1);
    expect(runs).toHaveLength(0);
    expect(outcome?.deferred).toBe(true);
    expect(defer).toHaveBeenCalledWith(
      'handoff',
      'codex:c1',
      expect.objectContaining({ cwd: CWD }),
      expect.objectContaining({ projectPath: CWD }),
    );
  });

  it('хранилище отказало — продолжения нет и цепочка не двигается', () => {
    const { deps, chains, runs } = setup({ open: () => undefined });

    expect(planForeignHandoff(input(), deps)).toBeUndefined();
    expect(runs).toHaveLength(0);
    expect(chains.depth(['codex:c1'])).toBe(0);
  });
});

describe('continuationTitle', () => {
  it('не копит суффиксы: третье продолжение читается как третье', () => {
    expect(continuationTitle('Группа · работа', 1)).toBe('Группа · работа · продолжение');
    expect(continuationTitle('Группа · работа · продолжение', 2)).toBe(
      'Группа · работа · продолжение 2',
    );
    expect(continuationTitle('Группа · работа · продолжение 2', 3)).toBe(
      'Группа · работа · продолжение 3',
    );
  });
});

describe('refusalNotice', () => {
  it('молчит ровно о двух причинах: блока не было и автомат выключен', () => {
    expect(refusalNotice('no_block')).toBeUndefined();
    expect(refusalNotice('auto_off')).toBeUndefined();
    expect(refusalNotice('chain_cap')).toBeTruthy();
  });
});
