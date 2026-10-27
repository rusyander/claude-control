import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inAgentWork } from './agent-zone.ts';
import { groupCommandVerdict } from './group-command.ts';

/**
 * D-8 (25.10): группа удаляла свои пустые снимки BEFORE из `.agent/screenshots/…`
 * своей копии — карточка человеку: весь `.agent/` судился локальным слоем, который
 * git не вернёт. Рабочие папки агента внутри `.agent/` (`.agent/<папка>/…`) — его
 * же выход; верхние файлы `.agent/` (заметки, PROGRESS), сам `.agent/`, шаблон
 * посреди пути, секрет и выход из копии — по-прежнему человеку.
 */
describe('удаление в рабочих папках `.agent/` своей копии (D-8)', () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'agent-zone-')));
  const copy = join(base, 'acme-worktrees', 'feat-a');
  const outside = join(base, 'elsewhere');
  const slash = (path: string): string => path.replace(/\\/g, '/');
  const scope = { worktree: copy, cwd: copy, branch: 'feat-a/x', ignored: ['.agent'] };
  const kind = (command: string): string => groupCommandVerdict(command, scope).kind;
  const shots = join(copy, '.agent', 'screenshots', 'before-after', 'gor55-e6');

  beforeAll(() => {
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, 'a_BEFORE.png'), '');
    writeFileSync(join(copy, '.agent', 'notes.md'), '');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(copy, '.agent', 'linked'), 'junction');
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  /** Дословная команда D-8, `W` — эта копия. */
  const D8 = (w: string): string =>
    `W=${w}; rm $W/.agent/screenshots/before-after/gor55-e6/*_BEFORE.png; taskkill //PID 6968 //T //F; taskkill //PID 30548 //T //F; netstat -ano | grep LISTENING | grep ":518" || echo "ports free"`;

  it('D-8: снимки в `.agent/screenshots/…` своей копии — уборка своего; погашения названы номерами', () => {
    expect(groupCommandVerdict(D8(slash(copy)), scope)).toMatchObject({
      kind: 'routine',
      deletes: true,
      kills: { pids: [6968, 30548], ports: [] },
    });
    expect(kind('rm .agent/screenshots/before-after/gor55-e6/a_BEFORE.png')).toBe('routine');
    expect(kind('rm -rf .agent/screenshots/before-after/gor55-e6')).toBe('routine');
  });

  it('верх `.agent/`, сам `.agent/`, шаблон посреди пути — человеку', () => {
    for (const command of [
      'rm .agent/notes.md',
      'rm .agent/*',
      'rm -rf .agent',
      'rm -rf .agent/screenshots',
      'rm .agent/*/before-after/a_BEFORE.png',
      'rm .agent/screenshots/*/gor55-e6/a_BEFORE.png',
    ]) {
      expect(kind(command), command).toBe('danger');
    }
  });

  it('выход из копии через `..`, ссылку или абсолютный путь и секрет — человеку', () => {
    for (const command of [
      'rm .agent/screenshots/../../../../elsewhere/x/a.png',
      'rm .agent/linked/x/a.png',
      `rm ${slash(outside)}/.agent/screenshots/x/a.png`,
      'rm .agent/screenshots/x/.env',
      'rm .agent/screenshots/x/id_rsa',
    ]) {
      expect(kind(command), command).toBe('danger');
    }
  });

  // Сам признак зоны, без прочих сторожей пути: шаблон допустим только в последней части.
  it('inAgentWork: глубина от трёх частей, шаблон только в имени файла', () => {
    expect(inAgentWork(['.agent', 'screenshots', '*_BEFORE.png'])).toBe(true);
    expect(inAgentWork(['.agent', 'notes.md'])).toBe(false);
    expect(inAgentWork(['.agent', '*', 'a.png'])).toBe(false);
    expect(inAgentWork(['.agent', 'screenshots', 'x?', 'a.png'])).toBe(false);
    expect(inAgentWork(['src', 'tmp', 'a.png'])).toBe(false);
  });
});
