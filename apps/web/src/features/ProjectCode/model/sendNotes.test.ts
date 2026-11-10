import { beforeEach, describe, expect, it, vi } from 'vitest';

const runs = vi.hoisted(() => ({
  steer: vi.fn(async () => 'steered' as const),
  enqueue: vi.fn(() => 'queued-1'),
}));
vi.mock('@shared/lib/agent-runs', () => ({ agentRuns: runs }));

const { sendNotes } = await import('./sendNotes');

const labels = { header: 'Заметки к правкам (2):', emptyLine: '(пустая строка)' };
const notes = [
  { path: 'b.txt', line: 2, text: 'строка b2', note: 'метка-1' },
  { path: 'a.txt', line: 5, text: 'строка a5', note: 'метка-2' },
];
const message = { allowEdits: true, model: 'sonnet', effort: 'high' };

function port(isRunning: boolean, accepted = true) {
  return { chatId: 'chat-1', isRunning, dispatch: vi.fn(async () => accepted), message };
}

describe('sendNotes: «Сейчас» / «В очередь» на дороги чата (D21, P172)', () => {
  beforeEach(() => {
    runs.steer.mockClear();
    runs.enqueue.mockClear();
  });

  it('агент работает, «Сейчас» — одно слово на ходу со всеми заметками', async () => {
    const clear = vi.fn();
    const p = port(true);
    expect(await sendNotes({ port: p, mode: 'now', notes, labels, clear })).toBe(true);
    expect(runs.steer).toHaveBeenCalledTimes(1);
    const [chatId, sent] = runs.steer.mock.calls[0] as unknown as [string, { prompt: string }];
    expect(chatId).toBe('chat-1');
    expect(sent).toMatchObject({ ...message, files: [] });
    expect(sent.prompt.indexOf('a.txt:5')).toBeLessThan(sent.prompt.indexOf('b.txt:2'));
    expect(runs.enqueue).not.toHaveBeenCalled();
    expect(p.dispatch).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('агент работает, «В очередь» — одно сообщение в очередь прогона, не на ходу', async () => {
    const clear = vi.fn();
    const p = port(true);
    await sendNotes({ port: p, mode: 'queue', notes, labels, clear });
    expect(runs.enqueue).toHaveBeenCalledTimes(1);
    const [, sent] = runs.enqueue.mock.calls[0] as unknown as [string, { prompt: string }];
    expect(sent.prompt).toContain('метка-1');
    expect(sent.prompt).toContain('метка-2');
    expect(runs.steer).not.toHaveBeenCalled();
    expect(p.dispatch).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('агент свободен — обе кнопки шлют одно обычное сообщение', async () => {
    for (const mode of ['now', 'queue'] as const) {
      const p = port(false);
      await sendNotes({ port: p, mode, notes, labels, clear: vi.fn() });
      expect(p.dispatch).toHaveBeenCalledTimes(1);
      const prompt = String((p.dispatch.mock.calls[0] as unknown as [string])[0]);
      expect(prompt.startsWith('Заметки к правкам (2):')).toBe(true);
      expect(prompt).toMatch(/a\.txt:5[\s\S]*b\.txt:2/);
    }
    expect(runs.steer).not.toHaveBeenCalled();
    expect(runs.enqueue).not.toHaveBeenCalled();
  });

  it('отказ отправки оставляет заметки: лоток не чистится', async () => {
    const clear = vi.fn();
    const p = port(false, false);
    expect(await sendNotes({ port: p, mode: 'now', notes, labels, clear })).toBe(false);
    expect(clear).not.toHaveBeenCalled();
  });

  it('лоток чистится только после ответа отправки, не до него', async () => {
    const order: string[] = [];
    const p = {
      ...port(false),
      dispatch: vi.fn(async () => {
        order.push('dispatch');
        return true;
      }),
    };
    await sendNotes({ port: p, mode: 'queue', notes, labels, clear: () => order.push('clear') });
    expect(order).toEqual(['dispatch', 'clear']);
  });

  it('пустой лоток ничего не шлёт', async () => {
    const p = port(false);
    expect(await sendNotes({ port: p, mode: 'now', notes: [], labels, clear: vi.fn() })).toBe(
      false,
    );
    expect(p.dispatch).not.toHaveBeenCalled();
  });
});
