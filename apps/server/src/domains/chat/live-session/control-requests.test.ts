import { describe, it, expect } from 'vitest';
import { ControlRequests } from './control-requests.ts';

/**
 * Управляющие запросы stdin CLI: строка `control_request` уходит в процесс,
 * ответ `control_response` находится по `request_id`. Формат — как у claude
 * 2.1.310 (замер `tools/qa/check-subagent-stop.mjs` на настоящем CLI).
 */

function sent(lines: string[]): { request_id: string; type: string; request: unknown } {
  return JSON.parse(lines.at(-1) ?? '{}') as {
    request_id: string;
    type: string;
    request: unknown;
  };
}

describe('ControlRequests', () => {
  it('пишет control_request строкой и закрывает его ответом с тем же request_id', async () => {
    const control = new ControlRequests();
    const lines: string[] = [];
    const reply = control.send((line) => lines.push(line), {
      subtype: 'stop_task',
      task_id: 'a1',
    });
    expect(lines[0]?.endsWith('\n')).toBe(true);
    const request = sent(lines);
    expect(request).toMatchObject({
      type: 'control_request',
      request: { subtype: 'stop_task', task_id: 'a1' },
    });
    // Чужой id и не-ответ — мимо: строка идёт дальше по ходу.
    expect(control.settle({ type: 'control_response', response: { request_id: 'x' } })).toBe(false);
    expect(control.settle({ type: 'assistant' })).toBe(false);
    expect(
      control.settle({
        type: 'control_response',
        response: { subtype: 'success', request_id: request.request_id },
      }),
    ).toBe(true);
    await expect(reply).resolves.toEqual({ outcome: 'ok' });
    // Повторный ответ на закрытый запрос уже не наш.
    expect(
      control.settle({
        type: 'control_response',
        response: { subtype: 'success', request_id: request.request_id },
      }),
    ).toBe(false);
  });

  it('ошибка CLI — refused с его текстом', async () => {
    const control = new ControlRequests();
    const lines: string[] = [];
    const reply = control.send((line) => lines.push(line), { subtype: 'stop_task' });
    control.settle({
      type: 'control_response',
      response: { subtype: 'error', request_id: sent(lines).request_id, error: 'No such task' },
    });
    await expect(reply).resolves.toEqual({ outcome: 'error', message: 'No such task' });
  });

  it('без ответа — unconfirmed по таймауту; закрытый процесс и сломанная запись — тоже', async () => {
    const slow = new ControlRequests(20);
    await expect(slow.send(() => undefined, { subtype: 'stop_task' })).resolves.toEqual({
      outcome: 'unconfirmed',
    });

    const closing = new ControlRequests();
    const pending = closing.send(() => undefined, { subtype: 'stop_task' });
    closing.failAll();
    await expect(pending).resolves.toEqual({ outcome: 'unconfirmed' });

    const broken = new ControlRequests();
    await expect(
      broken.send(() => {
        throw new Error('EPIPE');
      }, {}),
    ).resolves.toEqual({ outcome: 'unconfirmed' });
  });

  it('у каждого запроса свой request_id', () => {
    const control = new ControlRequests();
    const lines: string[] = [];
    void control.send((line) => lines.push(line), {});
    void control.send((line) => lines.push(line), {});
    const ids = lines.map((line) => (JSON.parse(line) as { request_id: string }).request_id);
    expect(new Set(ids).size).toBe(2);
    control.failAll();
  });
});
