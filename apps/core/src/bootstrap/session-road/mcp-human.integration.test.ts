import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_ECONOMY_DEFAULTS } from '@agentdeck/contracts/core/config';
import { codexRunFacts } from '@agentdeck/providers/codex';
import { gooseRunFacts } from '@agentdeck/providers/goose';
import { kimiRunFacts } from '@agentdeck/providers/kimi';
import { opencodeRunFacts } from '@agentdeck/providers/opencode';
import { mcpSecretValues } from '../../adapters/mcp-carry.ts';
import { WORK_HABITS_LINE } from '../../adapters/economy-carry.ts';
import { liveRoot, type LiveRoot } from '../../adapters/conformance/__fixtures__/live.ts';
import { fixturePath } from '../../adapters/conformance/__fixtures__/replay.ts';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { createRouteRegistry } from '../../routes/registry.ts';
import { createStubRoute } from '../../routes/stub/stub.ts';
import { roadStart } from '../__fixtures__/road-start.ts';
import { CREATED } from '../../journal/__fixtures__/journal-harness.ts';
import { bootCore, type BootedCore } from '../boot.ts';

/**
 * Серверы MCP человека на настоящей дороге (P73, s10 p7): `prepare` читает конфиг MCP самого CLI
 * сеанса (`adapter.mcpSource`) и выбор `config.mcpPicks` — выбранный и предложенный сервер
 * уходит в `mcpServers` шага, невыбранный — нет; шаг только чтения сервер без перечня
 * инструментов не получает. Секрет из `env` сервера — в записи шага, но НЕ в журнале задачи.
 */

const SECRET = 'mcp-secret-7f3a9c';
const route = createStubRoute({ name: 'mcp-human', script: ['x'] });

let core: BootedCore;
let live: LiveRoot;
const homeConfig: Record<string, (home: string) => [string, string]> = {
  [codexRunFacts.id]: (home) => [
    join(home, '.codex', 'config.toml'),
    [
      '[mcp_servers.picked]',
      'command = "picked-cmd"',
      `env = { TOKEN = "${SECRET}" }`,
      '[mcp_servers.unpicked]',
      'command = "unpicked-cmd"',
      '',
    ].join('\n'),
  ],
  [gooseRunFacts.id]: (home) => [
    process.platform === 'win32'
      ? join(home, 'AppData', 'Roaming', 'Block', 'goose', 'config', 'config.yaml')
      : join(home, '.config', 'goose', 'config.yaml'),
    [
      'extensions:',
      '  picked: { enabled: true, type: stdio, cmd: picked-cmd, args: [], envs: { TOKEN: ' +
        SECRET +
        ' } }',
      '  unpicked: { enabled: true, type: stdio, cmd: unpicked-cmd }',
      '',
    ].join('\n'),
  ],
  [opencodeRunFacts.id]: (home) => [
    join(home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({
      mcp: {
        picked: { type: 'local', command: ['picked-cmd'], environment: { TOKEN: SECRET } },
        unpicked: { type: 'local', command: ['unpicked-cmd'] },
      },
    }),
  ],
  claude: (home) => [
    join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        picked: { type: 'stdio', command: 'picked-cmd', env: { TOKEN: SECRET } },
        unpicked: { command: 'unpicked-cmd' },
      },
    }),
  ],
  [kimiRunFacts.id]: (home) => [
    join(home, '.kimi-code', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        picked: { command: 'picked-cmd', env: { TOKEN: SECRET } },
        unpicked: { command: 'unpicked-cmd' },
      },
    }),
  ],
};

beforeAll(async () => {
  core = await bootCore({
    home: join(tempDir('road-mcp-human-'), 'core'),
    build: 'road-mcp-human-test',
    panelAppData: null,
    loop: false,
    routes: createRouteRegistry([route]),
    loginPath: async () => ({ path: process.env.PATH ?? '', source: 'known-dirs' }),
  });
  live = liveRoot('road-mcp-human-');
  for (const make of Object.values(homeConfig)) {
    const [file, text] = make(live.home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  writeFileSync(
    core.layout.config,
    JSON.stringify({ mcpPicks: { work: ['picked', 'not-offered'], review: ['picked'] } }),
  );
}, 60_000);

// Остановка ядра закрывает каждую подготовленную задачу (их здесь 12): под нагрузкой машины — дольше минуты.
afterAll(async () => {
  await core?.stop();
}, 240_000);

/** Все байты каталога задачи (журнал, снимки, артефакты) — секрет не должен лечь ни в один. */
function allText(dir: string): string {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .map((path) => (statSync(path).isDirectory() ? allText(path) : readFileSync(path, 'latin1')))
    .join('\n');
}

async function prepareAs(adapterId: string, stepKind: string) {
  const task = await core.registry.create({
    ...CREATED,
    allowedRoutes: [
      { adapter: adapterId, route: { kind: 'stub', id: route.id }, modelPattern: '*' },
    ],
  });
  const start = {
    ...roadStart({
      live,
      bin: join(live.root, 'bin'),
      task,
      adapterId,
      fixture: fixturePath('claude', 'permit'),
      dump: join(live.root, `dump-${newId()}.json`),
    }),
    routeId: route.id,
    stepKind,
  };
  const got = await core.road.prepare(start);
  if (!got.ok) throw new Error(`${adapterId}: ${got.reason}`);
  return { task, prepared: got.prepared };
}

describe('session road: human MCP servers from the CLI config (P73, s10 p7)', () => {
  for (const adapterId of Object.keys(homeConfig)) {
    it(`${adapterId}: picked + offered reaches mcpServers, unpicked absent, secret not journaled`, async () => {
      const { task, prepared } = await prepareAs(adapterId, 'work');
      const servers = prepared.spec.mcpServers;
      expect(Object.keys(servers).sort()).toEqual(['agentdeck', 'agentdeck-permit', 'picked']);
      expect(servers.picked).toMatchObject({ command: 'picked-cmd', env: { TOKEN: SECRET } });
      // Токен ядра серверу человека не положен.
      expect(mcpSecretValues(servers.picked!)).not.toHaveProperty('AGENTDECK_SESSION_TOKEN');

      const dir = join(core.layout.tasks, task.taskId);
      expect(allText(dir)).not.toContain(SECRET);
      const note = readJournalLines(dir, task.taskId).lines.find(
        (l) => l.kind === 'signal' && (l.data as { signal?: string }).signal === 'mcp-human',
      ) as { data?: { detail?: string } } | undefined;
      expect(note?.data?.detail).toContain('picked: picked');
      expect(note?.data?.detail).toContain('dropped not-offered: picked but not offered');
      expect(note?.data?.detail).toContain('offered: picked(user), unpicked(user)');
    }, 60_000);
  }

  it('a read-only step drops a human server whose tool list is unread', async () => {
    const { prepared } = await prepareAs(codexRunFacts.id, 'review');
    expect(Object.keys(prepared.spec.mcpServers)).not.toContain('picked');
  }, 60_000);
});

describe('session road: economy levers from config.economy reach task steps, never the chat (s10 p8)', () => {
  it('work step: spec.economy = the section, brief carries the habits line; chat: none; out-of-schema section: none', async () => {
    const config = readFileSync(core.layout.config, 'utf8');
    try {
      writeFileSync(
        core.layout.config,
        JSON.stringify({
          economy: { compactWindow: 160_000, bashOutputChars: 6_000, workHabits: true },
        }),
      );
      const work = await prepareAs('claude', 'work');
      expect(work.prepared.spec.economy).toMatchObject({
        compactWindow: 160_000,
        bashOutputChars: 6_000,
        workHabits: true,
      });
      expect(work.prepared.spec.brief).toContain(WORK_HABITS_LINE);
      const chat = await prepareAs('claude', 'chat');
      expect(chat.prepared.spec.economy).toBeUndefined();
      expect(chat.prepared.spec.brief).not.toContain(WORK_HABITS_LINE);
      // Раздел вне схемы — рычаги не трогаются (причина — заметкой ядра), шаг идёт.
      writeFileSync(core.layout.config, JSON.stringify({ economy: { compactWindow: 5 } }));
      const bad = await prepareAs('claude', 'work');
      expect(bad.prepared.spec.economy).toBeUndefined();
    } finally {
      writeFileSync(core.layout.config, config);
    }
  }, 60_000);

  it('no economy section: the panel defaults (bash 8000, read 10000, ide off, habits); an explicit 0 / false stays off', async () => {
    const config = readFileSync(core.layout.config, 'utf8');
    try {
      writeFileSync(core.layout.config, JSON.stringify({}));
      const byDefault = await prepareAs('claude', 'work');
      expect(byDefault.prepared.spec.economy).toEqual({
        ...CORE_ECONOMY_DEFAULTS,
        ...(byDefault.prepared.spec.economy?.modelWindow
          ? { modelWindow: byDefault.prepared.spec.economy.modelWindow }
          : {}),
      });
      expect(byDefault.prepared.spec.brief).toContain(WORK_HABITS_LINE);
      writeFileSync(
        core.layout.config,
        JSON.stringify({
          economy: { bashOutputChars: 0, workHabits: false, readOutputTokens: 4_000 },
        }),
      );
      const off = await prepareAs('claude', 'work');
      expect(off.prepared.spec.economy).toMatchObject({ readOutputTokens: 4_000, detachIde: true });
      expect(off.prepared.spec.economy).not.toHaveProperty('bashOutputChars');
      expect(off.prepared.spec.economy).not.toHaveProperty('workHabits');
      expect(off.prepared.spec.brief).not.toContain(WORK_HABITS_LINE);
      const chat = await prepareAs('claude', 'chat');
      expect(chat.prepared.spec.economy).toBeUndefined();
    } finally {
      writeFileSync(core.layout.config, config);
    }
  }, 60_000);
});

describe('session road: panel chat gets the human servers by default (s10 p8, old chat parity)', () => {
  const journalNote = (taskId: string): string | undefined => {
    const dir = join(core.layout.tasks, taskId);
    const line = readJournalLines(dir, taskId).lines.find(
      (l) => l.kind === 'signal' && (l.data as { signal?: string }).signal === 'mcp-human',
    ) as { data?: { detail?: string } } | undefined;
    return line?.data?.detail;
  };

  for (const adapterId of ['claude', codexRunFacts.id]) {
    it(`${adapterId}: no mcpPicks.chat — every offered server is picked, the journal says «picked by default (chat)»`, async () => {
      const { task, prepared } = await prepareAs(adapterId, 'chat');
      expect(Object.keys(prepared.spec.mcpServers).sort()).toEqual([
        'agentdeck',
        'agentdeck-permit',
        'picked',
        'unpicked',
      ]);
      expect(journalNote(task.taskId)).toContain('picked by default (chat): picked, unpicked');
      expect(allText(join(core.layout.tasks, task.taskId))).not.toContain(SECRET);
    }, 60_000);
  }

  it('a present mcpPicks.chat is exact: [] = none, [picked] = only it; other kinds stay explicit', async () => {
    const config = readFileSync(core.layout.config, 'utf8');
    try {
      writeFileSync(core.layout.config, JSON.stringify({ mcpPicks: { chat: [] } }));
      const none = await prepareAs('claude', 'chat');
      expect(Object.keys(none.prepared.spec.mcpServers).sort()).toEqual([
        'agentdeck',
        'agentdeck-permit',
      ]);
      const work = await prepareAs('claude', 'work');
      expect(Object.keys(work.prepared.spec.mcpServers)).not.toContain('picked');
      writeFileSync(core.layout.config, JSON.stringify({ mcpPicks: { chat: ['picked'] } }));
      const one = await prepareAs('claude', 'chat');
      expect(Object.keys(one.prepared.spec.mcpServers).sort()).toEqual([
        'agentdeck',
        'agentdeck-permit',
        'picked',
      ]);
      expect(journalNote(one.task.taskId)).toContain('picked: picked');
      expect(journalNote(one.task.taskId)).not.toContain('by default');
    } finally {
      writeFileSync(core.layout.config, config);
    }
  }, 60_000);
});

describe('session road: the panel strict MCP layer (session.mcp core, G6)', () => {
  it('a task created with session.mcp core: the chat step gets only the core servers, no human server is offered', async () => {
    const task = await core.registry.create({
      ...CREATED,
      session: { mcp: 'core' },
      allowedRoutes: [
        { adapter: 'claude', route: { kind: 'stub', id: route.id }, modelPattern: '*' },
      ],
    });
    const start = {
      ...roadStart({
        live,
        bin: join(live.root, 'bin'),
        task,
        adapterId: 'claude',
        fixture: fixturePath('claude', 'permit'),
        dump: join(live.root, `dump-${newId()}.json`),
      }),
      routeId: route.id,
      stepKind: 'chat',
    };
    const got = await core.road.prepare(start);
    if (!got.ok) throw new Error(got.reason);
    // Тот же дом без поля — оба сервера человека (выбор чата по умолчанию, случай выше).
    expect(Object.keys(got.prepared.spec.mcpServers).sort()).toEqual([
      'agentdeck',
      'agentdeck-permit',
    ]);
  }, 60_000);
});
