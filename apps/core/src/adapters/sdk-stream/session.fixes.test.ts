import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionFile } from '../../session-host/protocol.ts';
import type { AdapterEvent } from '../adapter.types.ts';
import type { SdkRule } from './normalise.ts';
import { SdkSession } from './session.ts';

/**
 * Находки core-s2 по насосу сессии: строка вывода больше окна чтения не останавливает поток
 * и не теряет хвост (F-20); сбой сопоставления права в такте не роняет процесс необработанным
 * отказом и не оставляет вопрос CLI без ответа (F-42). Каталог сеанса пишет сам тест.
 */

const opened: SdkSession[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const EXIT = { v: 1, code: 0, signal: null, stopped: false, at: 1 };

function dir(text: string): string {
  const d = mkdtempSync(join(tmpdir(), 'sdk-session-fix-'));
  writeFileSync(sessionFile(d, 'stdout'), text);
  writeFileSync(sessionFile(d, 'exit'), JSON.stringify(EXIT));
  return d;
}

async function drain(s: SdkSession, ms = 10_000): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  const timer = setTimeout(() => s.close(), ms);
  for await (const e of s.events()) out.push(e);
  clearTimeout(timer);
  return out;
}

const RULE: SdkRule = {
  echo: true,
  mapPermission: (raw) => ({ action: 'exec', target: raw.tool, tool: raw.tool, display: raw.tool }),
};

describe('core-s2 sdk-stream session pump — big lines and failing permission mapping', () => {
  it('F-20 a 1.2 MB stdout line does not stall the pump: the line after it and the exit still arrive', async () => {
    const big = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(1_200_000) }] },
    });
    const s = new SdkSession(dir(`${big}\ntail-marker\n`), RULE, { pollMs: 10 });
    opened.push(s);
    const events = await drain(s);
    expect(events.some((e) => e.type === 'error' && e.detail.includes('tail-marker'))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'exited' });
    expect(s.position).toBe(Buffer.byteLength(big) + 1 + 'tail-marker\n'.length);
  });

  it('F-42 a permission mapping that throws inside the tick → named protocol error, the question still denied, stream ends on exit', async () => {
    const throwing: SdkRule = {
      echo: true,
      mapPermission: () => {
        throw new Error('codec boom');
      },
    };
    const line = JSON.stringify({
      type: 'control_request',
      request_id: 'p1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} },
    });
    const s = new SdkSession(dir(`${line}\n`), throwing, { pollMs: 10 });
    opened.push(s);
    const events = await drain(s);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        code: 'protocol',
        detail: expect.stringContaining('codec boom'),
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'exited' });
  });
});
