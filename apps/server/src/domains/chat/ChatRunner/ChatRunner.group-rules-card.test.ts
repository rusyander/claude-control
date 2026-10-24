import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Фаза G.2: звену группы личный `CLAUDE.md` заменяет карточка правил. Проверка
 * через настоящий запуск `ChatRun` — подменён только `spawn`: файл `--settings`
 * и окружение читаются такими, какими их получил бы CLI. Что CLI по этим
 * исключениям действительно снимает файл из запроса — замер `check-run-layers`
 * (−16,5 тыс. знаков без карточки, −14,5 тыс. с ней).
 */

class FakeChild extends EventEmitter {
  readonly stdin = Object.assign(new EventEmitter(), {
    write: (): boolean => true,
    end: () => undefined,
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

interface Seen {
  excludes: string[];
  env: Record<string, string | undefined>;
}

async function launch(options: {
  cwd: string;
  configDir: string;
  child: boolean;
  platformArgs?: string[];
}): Promise<Seen> {
  const seen: Seen = { excludes: [], env: {} };
  vi.resetModules();
  vi.doMock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    spawn: (_command: string, args: string[], spawnOptions: { env?: Seen['env'] }) => {
      seen.env = spawnOptions.env ?? {};
      args.forEach((arg, index) => {
        if (arg !== '--settings') return;
        const path = (args[index + 1] ?? '').replace(/^"|"$/g, '');
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { claudeMdExcludes?: string[] };
        seen.excludes.push(...(parsed.claudeMdExcludes ?? []));
      });
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    },
  }));
  const { ChatRun } = await import('./ChatRunner.ts');
  await new ChatRun().start({ prompt: 'ok', ...options }, () => undefined);
  return seen;
}

describe('ChatRunner: карточка правил группы вместо личного CLAUDE.md', () => {
  let base: string;
  let project: string;
  let config: string;

  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-runner-card-')));
    project = join(base, 'proj');
    config = join(base, 'config');
    mkdirSync(project);
    mkdirSync(config);
    writeFileSync(join(config, 'CLAUDE.md'), '# personal rules\n');
  });
  afterEach(() => {
    vi.doUnmock('node:child_process');
    rmSync(base, { recursive: true, force: true });
  });

  const personal = (seen: Seen): string[] =>
    seen.excludes.filter((pattern) =>
      /config.CLAUDE\.md$/i.test(pattern.replace(/\[(.)\w?\]/g, '$1')),
    );
  const writeCard = (): void => {
    mkdirSync(join(config, 'hooks', 'cards'), { recursive: true });
    writeFileSync(join(config, 'hooks', 'cards', 'group-rules.md'), '# card\n');
  };

  it('звено группы при карточке: личный CLAUDE.md снят, метка стоит', async () => {
    writeCard();
    const seen = await launch({ cwd: project, configDir: config, child: true });
    expect(personal(seen).length).toBeGreaterThan(0);
    expect(seen.env.AGENTDECK_USER_MEMORY_OFF).toBe('1');
    expect(seen.env.AGENTDECK_SPLIT_CHILD).toBe('1');
  });

  it('карточки нет — личные правила остаются целиком, метки нет', async () => {
    const seen = await launch({ cwd: project, configDir: config, child: true });
    expect(personal(seen)).toEqual([]);
    expect(seen.env.AGENTDECK_USER_MEMORY_OFF).toBeUndefined();
  });

  it('чат человека при карточке — личные правила не трогаются', async () => {
    writeCard();
    const seen = await launch({ cwd: project, configDir: config, child: false });
    expect(personal(seen)).toEqual([]);
    expect(seen.env.AGENTDECK_USER_MEMORY_OFF).toBeUndefined();
  });

  it('слой «Наши» уже снял личный файл — исключения не двоятся, метка стоит', async () => {
    const platformArgs = ['--setting-sources', 'project,local'];
    const seen = await launch({ cwd: project, configDir: config, child: true, platformArgs });
    const once = new Set(seen.excludes);
    expect(seen.excludes.length).toBe(once.size);
    expect(personal(seen).length).toBeGreaterThan(0);
    expect(seen.env.AGENTDECK_USER_MEMORY_OFF).toBe('1');
  });
});
