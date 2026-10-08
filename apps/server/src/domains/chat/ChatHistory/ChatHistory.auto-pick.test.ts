import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { autonomousPickMessage } from '@agentdeck/contracts/chat-group-settings';
import { readChatMessages, readLastAssistantTurn } from './ChatHistory.ts';

/**
 * Автовыбор в транскрипте: после перезагрузки ленты строка «Автовыбор» обязана
 * вернуться на свой вопрос, а усыновлённый прогон — не считать закрытый
 * автономией вопрос ожиданием человека. Обычный отказ (вопрос человеку) не
 * превращается в автовыбор.
 */
describe('ChatHistory — автовыбор из транскрипта', () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'cc-auto-pick-'));
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  const write = (lines: unknown[]): void => {
    const dir = join(projectsDir, 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's1.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  };

  const INPUT = {
    questions: [
      {
        question: 'Путь?',
        header: 'critical',
        options: [{ label: 'Быстрый' }, { label: 'Надёжный (Recommended)' }],
      },
    ],
  };
  const prompt = { type: 'user', uuid: 'u0', message: { role: 'user', content: 'работай' } };
  const question = {
    type: 'assistant',
    uuid: 'a1',
    message: {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: INPUT }],
    },
  };
  const result = (content: string) => ({
    type: 'user',
    uuid: 'u1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q1', content }] },
  });
  const closing = {
    type: 'assistant',
    uuid: 'a2',
    message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Беру надёжный.' }] },
  };
  const MESSAGE = autonomousPickMessage([
    { question: 'Путь?', label: 'Надёжный (Recommended)', critical: true },
  ]);

  it('выбор ложится на блок своего вопроса', async () => {
    write([prompt, question, result(MESSAGE), closing]);
    const page = await readChatMessages(projectsDir, 's1');
    const tool = page.messages.flatMap((m) => m.blocks).find((b) => b.type === 'tool');
    expect(tool).toMatchObject({
      name: 'AskUserQuestion',
      autoPicks: [{ question: 'Путь?', label: 'Надёжный (Recommended)' }],
    });
  });

  it('обычный отказ — без строки автовыбора', async () => {
    write([prompt, question, result('Вопрос показан человеку'), closing]);
    const page = await readChatMessages(projectsDir, 's1');
    const tool = page.messages.flatMap((m) => m.blocks).find((b) => b.type === 'tool');
    expect(tool).not.toHaveProperty('autoPicks');
  });

  it('усыновлённый прогон: вопрос, закрытый автономией, человека не ждёт', () => {
    write([prompt, question, result(MESSAGE), closing]);
    expect(readLastAssistantTurn(projectsDir, 's1')).toEqual({ text: 'Беру надёжный.' });
  });

  /**
   * F-142. Два вопроса в одном ходе, автономия закрыла один — второй, оставшийся
   * человеку, ждать не перестаёт: результат автовыбора снимал признак целиком.
   */
  it('усыновлённый прогон: автовыбор закрывает свой вопрос, а не соседний', () => {
    const two = {
      ...question,
      message: {
        ...question.message,
        content: [
          ...question.message.content,
          { type: 'tool_use', id: 'q2', name: 'AskUserQuestion', input: INPUT },
        ],
      },
    };
    const both = {
      type: 'user',
      uuid: 'u1',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'q1', content: MESSAGE },
          { type: 'tool_result', tool_use_id: 'q2', content: 'Вопрос показан человеку' },
        ],
      },
    };
    write([prompt, two, both, closing]);
    expect(readLastAssistantTurn(projectsDir, 's1')).toEqual({
      text: 'Беру надёжный.',
      asked: true,
    });
  });

  it('усыновлённый прогон: вопрос человеку — ждёт', () => {
    write([prompt, question, result('Вопрос показан человеку'), closing]);
    expect(readLastAssistantTurn(projectsDir, 's1')).toEqual({
      text: 'Беру надёжный.',
      asked: true,
    });
  });
});
