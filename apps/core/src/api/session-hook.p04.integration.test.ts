import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSessionStand, type SessionStand } from '../mcp/__fixtures__/session-stand.ts';

/**
 * P04 (F02-корпус) через настоящую ручку хука ядра: судья права НЕ читает текст команды —
 * команды, на которых текстовый разбор ошибался (`cd x; rm …`, `docker rm -f "$CID"`, `&>`,
 * heredoc), разрешаются. Разрушение вне копии ловит факт защищённых корней в конце шага (зона B),
 * не отказ по тексту. Контроль, что ручка вообще умеет отказать: запись в дом ядра — отказ по
 * пути, а не по тексту.
 */

const CORPUS = [
  'cd x; rm -rf b',
  'docker rm -f "$CID"',
  'npm test &> out.log',
  "cat <<'EOF' > notes.txt\nrm -rf /\nEOF",
  'rm -rf ../../outside && echo done',
];

let stand: SessionStand;
beforeAll(async () => {
  stand = await startSessionStand();
});
afterAll(() => stand.close());

async function hook(tool: string, input: Record<string, unknown>) {
  const res = await fetch(`${stand.url}/v1/session/hook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${stand.sessionToken}`,
    },
    body: JSON.stringify({ tool, input }),
  });
  return { status: res.status, body: (await res.json()) as { allow?: boolean; reason?: string } };
}

describe('P04: the permit judge never denies by command text (F02 corpus, real hook endpoint)', () => {
  it.each(CORPUS)('Bash %j → allowed', async (command) => {
    const got = await hook('Bash', { command });
    expect(got.status).toBe(200);
    expect(got.body.allow, got.body.reason).toBe(true);
  });

  it('control: the same endpoint denies a write into the core home (by path, not text)', async () => {
    const got = await hook('Write', {
      file_path: join(stand.registry.tasksDir, 'x.txt'),
      content: 'x',
    });
    expect(got.status).toBe(200);
    expect(got.body.allow).toBe(false);
  });
});
