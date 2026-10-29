import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sessionFile } from '../../session-host/protocol.ts';
import { readArtifact, runOnce } from './session-io.ts';

/** core-s2 F-97: вывод разового запуска и артефакт сессии не рвут UTF-8, копятся с потолком, срок снимает дерево. */

const root = mkdtempSync(join(tmpdir(), 'f97-'));
const leftovers: number[] = [];

afterAll(() => {
  for (const pid of leftovers) {
    try {
      process.kill(pid);
    } catch {
      // уже нет
    }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const env = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );

const node = (script: string, timeoutMs?: number, maxBytes?: number) =>
  runOnce('node', ['-e', script], env(), root, timeoutMs, maxBytes);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('launcher session-io: F-97', () => {
  it('readArtifact cuts head and tail on UTF-8 boundaries', () => {
    const dir = join(root, 'artifact');
    mkdirSync(dir, { recursive: true });
    writeFileSync(sessionFile(dir, 'stdout'), 'я'.repeat(10));
    const capped = readArtifact(dir, 'stdout', { headBytes: 5, tailBytes: 5 });
    expect(capped.truncated).toBe(true);
    expect(capped.text).not.toContain('�');
    expect(capped.text).toBe('яя\n… [12 bytes dropped] …\nяя');
  });

  it('runOnce decodes a character split across two chunks', async () => {
    const result = await node(
      'process.stdout.write(Buffer.from([0xd1]));setTimeout(()=>process.stdout.write(Buffer.from([0x8f])),200)',
    );
    expect(result.stdout).toBe('я');
  });

  it('runOnce keeps at most maxBytes per stream and names the dropped rest', async () => {
    const result = await node("process.stdout.write('x'.repeat(3*1024*1024))", 20_000, 1000);
    expect(result.ok).toBe(true);
    expect(result.stdout.length).toBeLessThan(1100);
    expect(result.stdout).toMatch(/^x{1000}\n… \[\d+ bytes dropped\] …$/);
  });

  it('runOnce on timeout stops the whole tree, grandchildren included', async () => {
    // Посредник — оболочка, не node: дочерние node на Windows и так гибнут с родителем (job-объект
    // libuv), а `cmd`/`sh` своих детей не снимают — как обёртка `.cmd` или скрипт-запускатель.
    writeFileSync(
      join(root, 'hang.js'),
      'process.stdout.write(String(process.pid));setInterval(()=>{},1000);',
    );
    const shell: [string, string[]] =
      process.platform === 'win32'
        ? ['cmd.exe', ['/d', '/c', 'node hang.js']]
        : ['sh', ['-c', 'node hang.js; true']];
    const result = await runOnce(shell[0], shell[1], env(), root, 3_000);
    expect(result.reason).toBe('timeout 3000 ms');
    const grandchild = Number(result.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    leftovers.push(grandchild);
    let gone = false;
    for (let i = 0; i < 20 && !gone; i += 1) {
      gone = !alive(grandchild);
      if (!gone) await new Promise((r) => setTimeout(r, 100));
    }
    expect(gone).toBe(true);
  }, 30_000);
});
