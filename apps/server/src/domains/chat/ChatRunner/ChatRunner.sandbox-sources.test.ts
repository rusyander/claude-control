import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Прогон песочницы читает настройки ТОЛЬКО из её каталога.
 *
 * Замерено настоящим `claude` против стаба (26.09.2026): рабочая папка песочницы
 * лежит под домом (`~/.agentdeck/sandboxes/<id>/work`), CLI ищет `CLAUDE.md`
 * вверх от неё и на `~` находит `~/.claude/CLAUDE.md` — личные правила
 * владельца приезжали в песочницу правилами ПРОЕКТА `~`, хотя
 * `CLAUDE_CONFIG_DIR` указывал на временный каталог. Из той же папки вне дома
 * их не было. `--setting-sources user` оставляет единственный источник —
 * каталог песочницы (он и есть `user` при `CLAUDE_CONFIG_DIR`), и проверяемое
 * правило доходит, а личные — нет (тот же замер).
 */

class FakeChild extends EventEmitter {
  readonly stdin = Object.assign(new EventEmitter(), {
    write: (_chunk: string): boolean => true,
    end: () => undefined,
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

async function argsOf(extra: {
  configDir?: string;
  settingSources?: string;
  platformArgs?: string[];
}): Promise<string[]> {
  let seen: string[] = [];
  const child = new FakeChild();

  vi.resetModules();
  vi.doMock('node:child_process', () => ({
    spawn: (_command: string, args: string[]) => {
      seen = args;
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    },
    spawnSync: () => ({ status: 0 }),
  }));

  const { ChatRun } = await import('./ChatRunner.ts');
  await new ChatRun().start({ prompt: 'вопрос', cwd: process.cwd(), ...extra }, () => undefined);
  return seen;
}

/** Значение флага, или `undefined`, если флага нет. */
function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.resetModules();
});

describe('ChatRun: источники настроек прогона с собственным каталогом конфигурации', () => {
  it('песочница читает только свой каталог — `--setting-sources user`', async () => {
    const args = await argsOf({ configDir: '/tmp/sandbox/config', settingSources: 'user' });

    expect(flag(args, '--setting-sources')).toBe('user');
  });

  it('свой каталог конфигурации без просьбы источники не сужает — слои проекта на месте', async () => {
    const args = await argsOf({ configDir: '/tmp/own/config' });

    expect(args).not.toContain('--setting-sources');
  });

  it('обычный чат источники не сужает', async () => {
    const args = await argsOf({});

    expect(args).not.toContain('--setting-sources');
  });

  it('флаг контура не дублируется: решает тот, что пришёл из контура', async () => {
    const args = await argsOf({
      configDir: '/tmp/sandbox/config',
      settingSources: 'user',
      platformArgs: ['--setting-sources', 'local'],
    });

    expect(args.filter((arg) => arg === '--setting-sources')).toHaveLength(1);
    expect(flag(args, '--setting-sources')).toBe('local');
  });
});
