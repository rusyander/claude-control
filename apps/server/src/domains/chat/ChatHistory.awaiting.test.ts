import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readChats } from './ChatHistory.ts';

/**
 * Признак «разговор стоит на вопросе к человеку».
 *
 * Считается из файла, а не из живого прогона: агента могли запустить в
 * терминале или в соседнем окне, панель о нём не знает, — а точка и звук нужны
 * всё равно. Проверяем ровно то, от чего зависит правдивость сигнала: вопрос
 * зажигает, ответ гасит, чужая ветка субагента не зажигает.
 */
describe('readChats — ожидание ответа человека', () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'cc-awaiting-'));
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  function write(lines: unknown[]): void {
    const dir = join(projectsDir, 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 's.jsonl'),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    );
  }

  const ask = {
    type: 'user',
    uuid: 'u0',
    cwd: 'C:/work/app',
    timestamp: '2026-08-01T10:00:00.000Z',
    message: { role: 'user', content: 'что выбрать?' },
  };

  const question = {
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-08-01T10:00:05.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [] } }],
    },
  };

  it('последний ход — вопрос с вариантами: ждём человека', () => {
    write([ask, question]);

    expect(readChats(projectsDir)[0]?.awaitingReply).toBe(true);
  });

  it('служебные записи после вопроса признак не гасят', () => {
    // CLI дописывает заголовок и отметку промпта — это не ответ человека.
    write([ask, question, { type: 'last-prompt' }, { type: 'ai-title', aiTitle: 'Выбор' }]);

    expect(readChats(projectsDir)[0]?.awaitingReply).toBe(true);
  });

  it('ответ человека гасит признак сразу, ещё до продолжения агента', () => {
    // Выбор варианта приходит результатом инструмента, а не репликой в ленте:
    // считай мы по видимым сообщениям, точка висела бы до следующего ответа.
    write([
      ask,
      question,
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-08-01T10:00:30.000Z',
        toolUseResult: { choices: ['первый'] },
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q1' }] },
      },
    ]);

    expect(readChats(projectsDir)[0]?.awaitingReply).toBeUndefined();
  });

  it('обычный последний ход агента ничего не зажигает', () => {
    write([
      ask,
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-08-01T10:00:05.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'готово' }] },
      },
    ]);

    expect(readChats(projectsDir)[0]?.awaitingReply).toBeUndefined();
  });

  it('вопрос внутри ветки субагента человека не зовёт', () => {
    // Субагент спрашивает своего родителя, а не человека у экрана.
    write([ask, { ...question, isSidechain: true }]);

    expect(readChats(projectsDir)[0]?.awaitingReply).toBeUndefined();
  });
});
