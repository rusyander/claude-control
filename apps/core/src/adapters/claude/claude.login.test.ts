import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AdapterEvent } from '../adapter.types.ts';
import { SdkNormaliser } from '../sdk-stream/normalise.ts';
import {
  CLAUDE_CAPS,
  classifyClaudeError,
  classifyClaudeLogin,
  createClaudeAdapter,
  loginStateOf,
  readClaudeLoginState,
} from './claude.ts';
import { mapClaudePermission } from './permission.ts';

/**
 * Потерянный вход Claude Code (этап 12, P170). Фикстуры — ЗАПИСАННЫЙ поток CLI 2.1.310
 * (временный каталог настроек; без входа — в режиме переходника `--input-format stream-json
 * --replay-user-messages`, с ключом, которому заглушка модели ответила 401, — `-p`); строка
 * `system init` (список слоя машины) убрана, id заменены, наш uuid команды оставлен. Поток идёт
 * через настоящий разборщик ядра: какой текст доходит до `turn.ended`, тот и судит переходник.
 */

const FIX = join(import.meta.dirname, '__fixtures__');

function turnEnd(file: string): Extract<AdapterEvent, { type: 'turn.ended' }> {
  const n = new SdkNormaliser({
    echo: false,
    mapPermission: mapClaudePermission,
    classifyError: classifyClaudeError,
  });
  n.expect('cmd-1', 'u-1');
  const events = readFileSync(join(FIX, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => n.push(line));
  const end = events.find((e) => e.type === 'turn.ended');
  if (!end || end.type !== 'turn.ended') throw new Error(`no turn.ended in ${file}`);
  return end;
}

describe('Claude login lost (stage 12, P170)', () => {
  it('recorded stream without a login: the turn ends in error and its text is classified login-lost', () => {
    const end = turnEnd('login-lost.jsonl');
    expect(end).toMatchObject({ isError: true, text: 'Not logged in · Please run /login' });
    expect(classifyClaudeLogin(end.text)).toBe(true);
    expect(createClaudeAdapter().loginLost?.(end.text)).toBe(true);
    expect(CLAUDE_CAPS.loginLost).toBe(true);
  });

  it('recorded 401 on an API key is not a lost login: the key is fixed, not /login', () => {
    const end = turnEnd('api-key-invalid.stream.jsonl');
    expect(end).toMatchObject({ isError: true, text: 'Invalid API key · Fix external API key' });
    expect(classifyClaudeLogin(end.text)).toBe(false);
  });

  it('documented variants on the last line count; the phrase inside other text or any error does not', () => {
    expect(classifyClaudeLogin('OAuth token has expired · Please run /login')).toBe(true);
    expect(
      classifyClaudeLogin(
        'API Error: 401 {"type":"error","error":{"type":"authentication_error"}} · Please run /login',
      ),
    ).toBe(true);
    expect(classifyClaudeLogin('tool said: "Not logged in · Please run /login" and more')).toBe(
      false,
    );
    expect(classifyClaudeLogin('API Error: 500 overloaded')).toBe(false);
    expect(classifyClaudeLogin('')).toBe(false);
  });

  it('login re-read: `claude auth status --json` loggedIn → up/absent; anything else → unknown', async () => {
    expect(loginStateOf('{"loggedIn":true,"authMethod":"claude.ai"}')).toBe('up');
    expect(loginStateOf('{"loggedIn":false,"authMethod":"none"}')).toBe('absent');
    expect(loginStateOf('{"authMethod":"none"}')).toBe('unknown');
    expect(loginStateOf('not json')).toBe('unknown');
    const seen: string[][] = [];
    const run = async (command: string, args: string[]) => {
      seen.push([command, ...args]);
      return { ok: false, code: 1, stdout: '{"loggedIn":false}', stderr: '' };
    };
    expect(await readClaudeLoginState('claude', {}, '.', run)).toBe('absent');
    expect(seen).toEqual([['claude', 'auth', 'status', '--json']]);
    const broken = async () => {
      throw new Error('spawn failed');
    };
    expect(await readClaudeLoginState('claude', {}, '.', broken)).toBe('unknown');
  });
});
