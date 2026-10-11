import { describe, it, expect } from 'vitest';
import {
  findToolUseId,
  hasToolResult,
  messagesOutput,
  permissionOutput,
  scanTranscript,
} from './outside-relay-hook-lib.mjs';

/**
 * Чистая часть хука пересылки. Ошибка здесь — решение с телефона, отданное не
 * тому вызову, или вопрос, на который ответили в окне, а телефон ждёт дальше.
 */

const line = (content: unknown[]) => JSON.stringify({ message: { content } });
const use = (id: string, name: string, input: unknown) =>
  line([{ type: 'tool_use', id, name, input }]);
const result = (id: string) => line([{ type: 'tool_result', tool_use_id: id, content: 'ok' }]);

describe('хвост транскрипта', () => {
  it('обрезанная первая строка и мусор пропускаются', () => {
    const text = ['":"обрывок"}}', use('a', 'Bash', {}), 'не json', result('a')].join('\n');
    const { uses, results } = scanTranscript(text);
    expect(uses.map((item) => item.id)).toEqual(['a']);
    expect([...results]).toEqual(['a']);
  });

  it('вызов, ждущий решения, — открытый вызов того же инструмента с тем же вводом', () => {
    const text = [
      use('old', 'Bash', { command: 'ls' }),
      result('old'),
      use('b1', 'Bash', { command: 'rm -rf dist' }),
      use('b2', 'Bash', { command: 'npm test' }),
      use('q1', 'AskUserQuestion', { questions: [] }),
    ].join('\n');
    expect(findToolUseId(text, 'Bash', { command: 'rm -rf dist' })).toBe('b1');
    // Ввод не совпал ни с одним (CLI нормализовал его) — последний открытый.
    expect(findToolUseId(text, 'Bash', { command: 'другое' })).toBe('b2');
    // Закрытый вызов не берётся даже при совпавшем вводе.
    expect(findToolUseId(text, 'Bash', { command: 'ls' })).toBe('b2');
    expect(findToolUseId(text, 'Write', {})).toBeUndefined();
  });

  it('ответ в окне виден по результату вызова', () => {
    const text = [use('q1', 'AskUserQuestion', {})].join('\n');
    expect(hasToolResult(text, 'q1')).toBe(false);
    expect(hasToolResult(`${text}\n${result('q1')}`, 'q1')).toBe(true);
  });
});

describe('решение для CLI', () => {
  const input = { questions: [{ question: 'Какой?' }] };

  it('ответ на вопрос — разрешение с ответами внутри ввода', () => {
    expect(permissionOutput({ state: 'answered', answers: { 'Какой?': 'Синий' } }, input)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { ...input, answers: { 'Какой?': 'Синий' } } },
      },
    });
  });

  it('права: «разрешить» и «запретить» с причиной для модели', () => {
    expect(permissionOutput({ state: 'decided', behavior: 'allow' }, {})).toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
    const denied = permissionOutput({ state: 'decided', behavior: 'deny' }, {});
    expect(denied?.hookSpecificOutput.decision).toMatchObject({ behavior: 'deny' });
    expect(denied?.hookSpecificOutput.decision.message).toMatch(/телефон/);
  });

  it('отпущенный, неизвестный, ждущий — без решения: решает окно', () => {
    for (const state of ['released', 'unknown', 'pending']) {
      expect(permissionOutput({ state }, {})).toBeUndefined();
    }
  });
});

describe('сообщения с телефона посреди хода', () => {
  it('после шага — контекстом, в конце хода — отказом остановиться', () => {
    const step = messagesOutput('PostToolUse', ['проверь ещё вёрстку']);
    expect(step?.hookSpecificOutput?.hookEventName).toBe('PostToolUse');
    expect(step?.hookSpecificOutput?.additionalContext).toContain('проверь ещё вёрстку');
    const stop = messagesOutput('Stop', ['первое', 'второе']);
    expect(stop).toMatchObject({ decision: 'block' });
    expect(stop?.reason).toMatch(/первое[\s\S]*второе/);
  });

  it('нечего отдавать — хук молчит, ход идёт как без него', () => {
    expect(messagesOutput('PostToolUse', [])).toBeUndefined();
    expect(messagesOutput('Stop', [])).toBeUndefined();
  });
});
