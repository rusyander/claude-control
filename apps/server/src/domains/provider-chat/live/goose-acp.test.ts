import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GooseAcpTurn } from './goose-acp.ts';
import type { LivePermissionAsk, LiveTurnOptions } from './types.ts';

/**
 * «Разрешить правки» у живого `goose acp` (L-goose, 06.10.2026). Снято с Goose
 * 1.53.0: в режиме `auto` — а он у Goose по умолчанию — `session/request_permission`
 * не приходит НИКОГДА, инструмент правки просто выполняется. Значит, ответ
 * через `decidePermission` сам по себе переключатель не исполняет: сессию надо
 * перевести в `approve` (ACP `session/set_mode`, режим живёт в сессии, config.yaml
 * человека не меняется — тоже снято). Подделка ведёт себя так же
 * (`fixtures/fake-goose-acp.mjs`, `FAKE_MODE=tool`).
 */

const fixture = fileURLToPath(new URL('./fixtures/fake-goose-acp.mjs', import.meta.url));

function options(env: Record<string, string>): {
  opts: LiveTurnOptions;
  stderr: () => string;
} {
  let stderr = '';
  const spawnImpl = ((_command: string, args: string[], spawnOptions: object) => {
    const child = spawn(process.execPath, [fixture, ...args], spawnOptions);
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    return child;
  }) as unknown as LiveTurnOptions['spawnImpl'];
  return {
    opts: {
      command: process.execPath,
      prompt: 'вопрос человека',
      timeoutMs: 15_000,
      env: { FAKE_MODE: 'tool', HOLD_MS: '10', ...env },
      spawnImpl,
    },
    stderr: () => stderr,
  };
}

describe('goose acp: режим сессии под «Разрешить правки»', () => {
  it('правки выключены, Goose в auto — сессия переведена в approve, вопрос ушёл человеку', async () => {
    const asked: LivePermissionAsk[] = [];
    const { opts, stderr } = options({ FAKE_GOOSE_MODE: 'auto' });
    const result = await new GooseAcpTurn().run(
      { ...opts, permission: { allowEdits: false, ask: async (r) => (asked.push(r), 'deny') } },
      () => {},
    );
    expect(stderr()).toContain('set_mode approve');
    expect(asked).toHaveLength(1);
    expect(result).toEqual({
      kind: 'done',
      reply: 'ответ на рос человека / разрешение: reject_once',
    });
  });

  it('правки выключены, политики нет вовсе — тоже approve, и просьба получает отказ', async () => {
    const { opts, stderr } = options({ FAKE_GOOSE_MODE: 'smart_approve' });
    const result = await new GooseAcpTurn().run(opts, () => {});
    expect(stderr()).toContain('set_mode approve');
    expect(result).toEqual({
      kind: 'done',
      reply: 'ответ на рос человека / разрешение: reject_once',
    });
  });

  it('правки выключены, Goose уже в approve или chat — режим не трогаем', async () => {
    for (const current of ['approve', 'chat']) {
      const { opts, stderr } = options({ FAKE_GOOSE_MODE: current });
      await new GooseAcpTurn().run(
        { ...opts, permission: { allowEdits: false, ask: async () => 'deny' } },
        () => {},
      );
      expect(stderr()).not.toContain('set_mode');
    }
  });

  it('правки разрешены — режим человека остаётся, auto выполняет без вопроса', async () => {
    const { opts, stderr } = options({ FAKE_GOOSE_MODE: 'auto' });
    const result = await new GooseAcpTurn().run(
      { ...opts, permission: { allowEdits: true, ask: async () => 'deny' } },
      () => {},
    );
    expect(stderr()).not.toContain('set_mode');
    expect(result).toEqual({
      kind: 'done',
      reply: 'ответ на рос человека / инструмент: без вопроса',
    });
  });

  it('правки разрешены, но есть судья команд — approve, команда уходит судье, не «да» переключателя', async () => {
    const judged: string[] = [];
    let asked = 0;
    const { opts, stderr } = options({
      FAKE_GOOSE_MODE: 'auto',
      FAKE_TOOL_COMMAND: 'git branch -D old',
    });
    const result = await new GooseAcpTurn().run(
      {
        ...opts,
        permission: {
          allowEdits: true,
          ask: async () => (asked++, 'allow'),
          judge: async (shell) => (
            judged.push(`${shell.shell}:${shell.command}`),
            { behavior: 'deny', message: 'нет' }
          ),
        },
      },
      () => {},
    );
    // Без approve Goose в auto не спросил бы вовсе — и судья не увидел бы `git branch -D`.
    expect(stderr()).toContain('set_mode approve');
    expect(judged).toEqual([
      `${process.platform === 'win32' ? 'unknown' : 'bash'}:git branch -D old`,
    ]);
    expect(asked).toBe(0);
    expect(result).toEqual({
      kind: 'done',
      reply: 'ответ на рос человека / разрешение: reject_once',
    });
  });

  it('режим сменить не удалось — ход не начинается (unavailable), без правок молча не бывает', async () => {
    const { opts } = options({ FAKE_GOOSE_MODE: 'auto', FAKE_SET_MODE: 'error' });
    const result = await new GooseAcpTurn().run(
      { ...opts, permission: { allowEdits: false, ask: async () => 'deny' } },
      () => {},
    );
    expect(result.kind).toBe('unavailable');
  });
});
