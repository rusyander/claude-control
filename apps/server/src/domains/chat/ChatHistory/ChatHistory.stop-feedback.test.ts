import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLastAssistantTurn } from './ChatHistory.ts';

/**
 * Журнал 19.10 01:44 (L7.2): хук Stop вернул группе замечание после итогового
 * ответа, и последним ходом в транскрипте стал ответ НА ЗАМЕЧАНИЕ — без блоков
 * сит, предложения и ссылки на итог. Усыновлённый прогон судил по нему одному и
 * терял всё, что агент сказал в итоге. Закрывающий ход — ответ на последнюю
 * реплику человека вместе с ответами на замечания хуков после него.
 * Форма записей — из транскрипта CLI 2.1.286 (`isMeta`, «Stop hook feedback:»).
 */
describe('ChatHistory — ответ на замечание хука Stop не заслоняет итог', () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'cc-stop-feedback-'));
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  const write = (lines: unknown[]): void => {
    const dir = join(projectsDir, 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's1.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  };

  const human = (text: string, uuid: string) => ({
    type: 'user',
    uuid,
    message: { role: 'user', content: text },
  });
  const say = (id: string, text: string) => ({
    type: 'assistant',
    uuid: `a-${id}`,
    message: { id, role: 'assistant', content: [{ type: 'text', text }] },
  });
  const call = (id: string, toolId: string) => ({
    type: 'assistant',
    uuid: `a-${id}`,
    message: {
      id,
      role: 'assistant',
      content: [
        { type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'node --check x' } },
      ],
    },
  });
  const result = (toolId: string) => ({
    type: 'user',
    uuid: `r-${toolId}`,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }],
    },
  });
  const stopFeedback = {
    type: 'user',
    uuid: 'stop-1',
    isMeta: true,
    message: {
      role: 'user',
      content:
        'Stop hook feedback:\nverify-at-stop: this turn edited 1 code file and no check ran.',
    },
  };

  const SUMMARY = 'Все 5 задач в Review.\n\n```agentdeck:sieves\n- owner-5: pass\n```';

  it('итог и ответ на замечание — один закрывающий ход', () => {
    write([
      human('доведи группу', 'u0'),
      say('m1', SUMMARY),
      stopFeedback,
      call('m2', 't1'),
      result('t1'),
      say('m3', 'Проверка была, она зелёная.'),
    ]);
    const turn = readLastAssistantTurn(projectsDir, 's1');
    expect(turn?.text).toContain('agentdeck:sieves');
    expect(turn?.text).toContain('Проверка была, она зелёная.');
    expect(turn?.text.indexOf('agentdeck:sieves')).toBeLessThan(
      turn?.text.indexOf('Проверка была') ?? -1,
    );
  });

  it('реплика человека после замечания начинает ход заново: прежний итог не тянется', () => {
    write([
      human('доведи группу', 'u0'),
      say('m1', SUMMARY),
      stopFeedback,
      say('m2', 'Проверка была.'),
      human('что с MR?', 'u1'),
      say('m3', 'MR открыт.'),
    ]);
    expect(readLastAssistantTurn(projectsDir, 's1')?.text).toBe('MR открыт.');
  });

  it('обрыв посреди ответа на замечание — хода нет, как и раньше', () => {
    write([human('доведи группу', 'u0'), say('m1', SUMMARY), stopFeedback, call('m2', 't1')]);
    expect(readLastAssistantTurn(projectsDir, 's1')).toBeUndefined();
  });
});
