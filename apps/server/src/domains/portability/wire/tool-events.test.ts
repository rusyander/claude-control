import { describe, it, expect } from 'vitest';
import { CATALOG_PROVIDERS } from '../../../providers/catalog.ts';
import type { ConfigProvider } from '../../../providers/types.ts';
import { runToolEvent, toolEventOwner } from './tool-events.ts';

/**
 * У событий инструментов есть третье состояние владельца, которого нет у событий
 * прогона: отыгрывать НЕЧЕМ. Вызов виден только в пути запроса, и без контура в
 * этом пути панель его не видит ни при каких настройках.
 *
 * Хуки здесь запускаются настоящими процессами: словарь кодов выхода и канал
 * причины — ровно то, что эта пара обязана унаследовать у событий прогона, и
 * подменённый запуск доказывал бы только вызов функции.
 */

function providerOf(id: string): ConfigProvider {
  const found = CATALOG_PROVIDERS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`в каталоге нет цели ${id}`);
  return found;
}

const RUN = {
  providerId: 'codex',
  sessionId: 'chat-1',
  cwd: process.cwd(),
  transcriptPath: 'C:/appdata/provider-chats/codex/chat-1.jsonl',
};

const CALL = { id: 'call-1', name: 'Write', input: { file_path: 'a.ts' } };

/** Скрипт, который НЕ должен запуститься: его запуск был бы виден отказом. */
const NEVER = [{ event: 'PreToolUse' as const, command: 'node -e "process.exit(2)"' }];

describe('владелец события инструмента', () => {
  it('у цели со своим механизмом — она сама, даже когда трафик идёт через контур', () => {
    // Иначе скрипт человека сработал бы дважды на одно действие, а решение об
    // отказе нельзя принять два раза: второе уже бессмысленно.
    expect(toolEventOwner(providerOf('qwen'), 'PreToolUse', { throughContour: true })).toBe(
      'native',
    );
  });

  it('у цели без механизма — провод, но ТОЛЬКО через контур', () => {
    const codex = providerOf('codex');
    expect(toolEventOwner(codex, 'PreToolUse', { throughContour: true })).toBe('wire');
    expect(toolEventOwner(codex, 'PreToolUse', { throughContour: false })).toBe('none');
    expect(toolEventOwner(codex, 'PostToolUse', { throughContour: false })).toBe('none');
  });
});

describe('событие без владельца', () => {
  it('хуков не запускает и вызов ПРОПУСКАЕТ, а не запрещает', async () => {
    // Отсутствие события — это отсутствие события. Выдать его за запрет значило
    // бы остановить работу агента там, где человек ни о чём не просил.
    const decision = await runToolEvent({
      provider: providerOf('codex'),
      run: RUN,
      call: CALL,
      event: 'PreToolUse',
      hooks: NEVER,
      conditions: { throughContour: false },
    });

    expect(decision).toEqual({ allow: true, owner: 'none' });
  });

  it('родной механизм цели провод тоже не дублирует', async () => {
    const decision = await runToolEvent({
      provider: providerOf('qwen'),
      run: { ...RUN, providerId: 'qwen' },
      call: CALL,
      event: 'PreToolUse',
      hooks: NEVER,
      conditions: { throughContour: true },
    });

    expect(decision).toEqual({ allow: true, owner: 'native' });
  });
});

describe('событие на проводе', () => {
  it('код 2 запрещает вызов, а причиной едет STDERR скрипта', async () => {
    const decision = await runToolEvent({
      provider: providerOf('codex'),
      run: RUN,
      call: CALL,
      event: 'PreToolUse',
      hooks: [
        {
          event: 'PreToolUse',
          command: 'node -e "process.stderr.write(\'сюда писать нельзя\');process.exit(2)"',
        },
      ],
      conditions: { throughContour: true },
    });

    expect(decision.owner).toBe('wire');
    expect(decision.allow).toBe(false);
    // Причина — слова СКРИПТА. Панель, подставляющая здесь «хук вышел с кодом 2»,
    // оставляет правило без объяснения ровно там, где объяснение и нужно: и
    // человеку в заметку, и модели на место запрещённого вызова.
    expect(decision.reason).toBe('сюда писать нельзя');
  });

  it('скрипт видит имя инструмента и его аргументы — иначе судить ему нечем', async () => {
    // Хук отказывает ТОЛЬКО если разобрал нагрузку со stdin. Пропуск здесь
    // означал бы, что вызов до него доехал пустым: так и было, пока имена полей
    // на шве шлюза не совпали (`arguments` против `input`).
    const decision = await runToolEvent({
      provider: providerOf('codex'),
      run: RUN,
      call: { id: 'call-1', name: 'Write', input: { file_path: 'secrets/key.txt' } },
      event: 'PreToolUse',
      hooks: [
        {
          event: 'PreToolUse',
          command:
            "node -e \"let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const p=JSON.parse(s);" +
            "if(p.tool_name==='Write'&&String(p.tool_input.file_path).startsWith('secrets/'))" +
            "{process.stderr.write('в secrets/ писать нельзя');process.exit(2)}process.exit(0)})\"",
        },
      ],
      conditions: { throughContour: true },
    });

    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('в secrets/ писать нельзя');
  });

  it('тот же скрипт на разрешённом пути вызов пропускает', async () => {
    // Половина «красным» без половины «зелёным» доказывала бы лишь то, что скрипт
    // отказывает всегда.
    const decision = await runToolEvent({
      provider: providerOf('codex'),
      run: RUN,
      call: CALL,
      event: 'PreToolUse',
      hooks: [
        {
          event: 'PreToolUse',
          command:
            "node -e \"let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const p=JSON.parse(s);" +
            "if(String(p.tool_input.file_path).startsWith('secrets/'))" +
            "{process.stderr.write('нельзя');process.exit(2)}process.exit(0)})\"",
        },
      ],
      conditions: { throughContour: true },
    });

    expect(decision.allow).toBe(true);
    expect(decision.reason).toBeUndefined();
    expect(decision.outcome?.results).toHaveLength(1);
  });

  it('`PostToolUse` отказать не может: останавливать уже нечего', async () => {
    // Наблюдательное событие с правом запрета врало бы модели о том, чего не
    // было: инструмент к этому времени уже отработал.
    const decision = await runToolEvent({
      provider: providerOf('codex'),
      run: RUN,
      call: CALL,
      event: 'PostToolUse',
      response: { ok: true },
      hooks: [
        {
          event: 'PostToolUse',
          command: 'node -e "process.stderr.write(\'поздно\');process.exit(2)"',
        },
      ],
      conditions: { throughContour: true },
    });

    expect(decision.allow).toBe(true);
    expect(decision.outcome?.results[0]?.ignoredOnObservingEvent).toBe(true);
  });

  it('хуки другого события не зовутся', async () => {
    const decision = await runToolEvent({
      provider: providerOf('codex'),
      run: RUN,
      call: CALL,
      event: 'PreToolUse',
      hooks: [
        {
          event: 'PostToolUse',
          command: 'node -e "process.stderr.write(\'чужое событие\');process.exit(2)"',
        },
      ],
      conditions: { throughContour: true },
    });

    expect(decision.allow).toBe(true);
    expect(decision.outcome?.results).toHaveLength(0);
  });
});
