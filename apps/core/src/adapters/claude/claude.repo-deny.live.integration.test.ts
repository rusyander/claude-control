import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import type { LayerRun, SessionSpec } from '../adapter.types.ts';
import {
  EventTap,
  hookCommand,
  liveRoot,
  liveSpec,
  type LiveRoot,
} from '../conformance/__fixtures__/live.ts';
import { CLAUDE_CHANNELS, createClaudeAdapter } from './claude.ts';
import { claudeAbsolutePattern } from './path-pattern.ts';

/**
 * F-86 на живом Claude Code над заглушкой модели: копия недоверенного репозитория не грузит его
 * настройки, но запреты репозитория (`permissions.deny` из `.claude/settings.json` и
 * `settings.local.json` ИСХОДНОГО репозитория) доходят до сеанса данными — через `--settings`
 * ядра. Команда-метка, которую разрешил человек, а репозиторий запретил, не исполняется; путь
 * `/secret.txt` (от корня репозитория) не читается. Контроль — та же копия без запретов
 * репозитория: метка исполняется, секрет читается. Доверенная копия в `observe` получает правило
 * пути от корня копии, а не от каталога сеанса, где лежит `--settings`.
 */

const present = hasCli(claudeRunFacts.binary.command);
const roots: LiveRoot[] = [];
const stubs: StubModel[] = [];
const SECRET = 'REPO_DENY_SECRET_7f3a';
const MARKER = 'repo-deny-marker.txt';
const CONFIG_SECRET = 'HUMAN_CFG_SECRET_51d0';

afterAll(async () => {
  for (const stub of stubs) await stub.close();
  for (const root of roots) rmSync(root.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

interface Run {
  layer: LayerRun;
  markerRan: boolean;
  secretRead: boolean;
  /** Секрет в каталоге настроек человека (`~/.claude/secret.txt`) дошёл до модели. */
  configSecretRead: boolean;
}

interface Setup {
  /** Запреты в настройках человека. */
  humanDeny?: string[];
  /** Каталог, чьи `.claude/settings*.json` несут запреты репозитория. */
  repo: (live: LiveRoot) => string;
  trust: (live: LiveRoot) => SessionSpec['trust'];
  layer: SessionSpec['layer'];
  /** Запреты `settings.json` и `settings.local.json` (null — файла нет). */
  deny: [string[] | null, string[] | null];
}

async function run(prefix: string, setup: Setup): Promise<Run> {
  const live = liveRoot(prefix);
  roots.push(live);
  // Человек разрешил команду-метку: без запрета репозитория она исполняется без вопроса.
  writeJson(join(live.home, '.claude', 'settings.json'), {
    permissions: {
      // Чтение вне копии без вопроса — только по разрешению человека: так видно, что делает запрет.
      allow: ['Bash(touch:*)', `Read(${claudeAbsolutePattern(join(live.home, '.claude'))}/**)`],
      ...(setup.humanDeny ? { deny: setup.humanDeny } : {}),
    },
  });
  writeFileSync(join(live.home, '.claude', 'secret.txt'), `${CONFIG_SECRET}\n`);
  const repo = setup.repo(live);
  const [main, local] = setup.deny;
  if (main) writeJson(join(repo, '.claude', 'settings.json'), { permissions: { deny: main } });
  if (local) {
    writeJson(join(repo, '.claude', 'settings.local.json'), { permissions: { deny: local } });
  }
  writeFileSync(join(live.cwd, 'secret.txt'), `${SECRET}\n`);
  const stub = await startStubModel({
    script: {
      steps: [
        { tool: { name: 'Bash', args: { command: `touch ${MARKER}`, description: 'marker' } } },
        { tool: { name: 'Read', args: { file_path: join(live.cwd, 'secret.txt') } } },
        { tool: { name: 'Read', args: { file_path: join(live.home, '.claude', 'secret.txt') } } },
        'DONE_MARKER',
      ],
    },
  });
  stubs.push(stub);
  const adapter = createClaudeAdapter();
  const spec = liveSpec(live, {
    endpoint: {
      channel: CLAUDE_CHANNELS[0]!,
      endpoint: {
        baseUrl: stub.baseUrl,
        dialect: 'anthropic-messages',
        model: 'stub-model',
        key: 'k',
      },
    },
    coreHook: hookCommand('core', live.logs.core),
    layer: setup.layer,
  });
  spec.trust = setup.trust(live);
  const launched = await adapter.launch(spec);
  if (!launched.ok) throw new Error(launched.reason);
  const tap = new EventTap(adapter, launched.handle);
  try {
    await adapter.send(launched.handle, 'touch the marker, read the secret', crypto.randomUUID());
    const ended = await tap.until((e) => e.type === 'turn.ended', 150_000);
    expect(ended.type === 'turn.ended' ? ended.text : '').toBe('DONE_MARKER');
  } finally {
    await adapter.stop(launched.handle, 'soft');
  }
  // Секрет в запросе к модели — значит, результат `Read` дошёл до неё.
  const bodies = stub.bodies.join('\n');
  return {
    layer: launched.layer,
    markerRan: existsSync(join(live.cwd, MARKER)),
    secretRead: bodies.includes(SECRET),
    configSecretRead: bodies.includes(CONFIG_SECRET),
  };
}

const source = (live: LiveRoot): string => join(live.root, 'source');
const untrusted = (live: LiveRoot): SessionSpec['trust'] => ({
  sourceRepo: source(live),
  panelMark: false,
});

describe.skipIf(!present)('claude adapter on the real CLI — F-86 repo deny in a copy', () => {
  it('F-86 control: an untrusted copy whose source repo denies nothing runs the marker and reads the secret', async () => {
    const result = await run('claude-f86-deny-ctl-', {
      repo: source,
      trust: untrusted,
      layer: { hooks: 'on', skills: 'on' },
      deny: [null, null],
    });
    expect(result.layer).toMatchObject({ ran: 'observe', repoLayer: false });
    expect(result.markerRan).toBe(true);
    expect(result.secretRead).toBe(true);
  }, 240_000);

  it("F-86: an untrusted copy keeps the source repo's deny rules (settings.json + settings.local.json)", async () => {
    const result = await run('claude-f86-deny-', {
      repo: source,
      trust: untrusted,
      layer: { hooks: 'on', skills: 'on' },
      deny: [['Bash(touch:*)'], ['Read(/secret.txt)']],
    });
    expect(result.layer).toMatchObject({ ran: 'observe', repoLayer: false });
    expect(result.markerRan).toBe(false);
    expect(result.secretRead).toBe(false);
    expect(result.layer.detail).toMatch(/2 repo deny rules carried/);
  }, 240_000);

  it("F-86: a trusted copy in observe anchors the repo's /path rule at the copy root", async () => {
    const result = await run('claude-f86-deny-obs-', {
      repo: (live) => live.cwd,
      trust: (live) => ({ sourceRepo: live.cwd, panelMark: true }),
      layer: { hooks: 'observe', skills: 'on' },
      deny: [['Read(/secret.txt)'], null],
    });
    expect(result.layer).toMatchObject({ ran: 'observe', repoLayer: true });
    expect(result.markerRan).toBe(true);
    expect(result.secretRead).toBe(false);
  }, 240_000);

  const trustedCwd = (live: LiveRoot): SessionSpec['trust'] => ({
    sourceRepo: live.cwd,
    panelMark: true,
  });

  it('control: the human allow opens ~/.claude/secret.txt when nothing denies it', async () => {
    const result = await run('claude-f86-deny-human-ctl-', {
      repo: (live) => live.cwd,
      trust: trustedCwd,
      layer: { hooks: 'on', skills: 'on' },
      deny: [null, null],
    });
    expect(result.configSecretRead).toBe(true);
    expect(result.secretRead).toBe(true);
  }, 240_000);

  // Как CLI сам понимает `/x`: в файле человека — от каталога этого файла (`~/.claude`), в файле
  // проекта — от корня проекта. Сеанс ядра в `observe` должен сохранить оба смысла.
  it.each(['on', 'observe'] as const)(
    "the human's /path rule means ~/.claude/x in layer %s, never the copy's file",
    async (mode) => {
      const result = await run(`claude-f86-deny-human-${mode}-`, {
        repo: (live) => live.cwd,
        trust: trustedCwd,
        layer: { hooks: mode, skills: 'on' },
        deny: [null, null],
        humanDeny: ['Read(/secret.txt)'],
      });
      expect(result.layer).toMatchObject({ ran: mode });
      expect(result.configSecretRead).toBe(false);
      expect(result.secretRead).toBe(true);
    },
    240_000,
  );

  it("the project's /path rule means the copy root in layer on (the CLI's own reading)", async () => {
    const result = await run('claude-f86-deny-proj-on-', {
      repo: (live) => live.cwd,
      trust: trustedCwd,
      layer: { hooks: 'on', skills: 'on' },
      deny: [['Read(/secret.txt)'], null],
    });
    expect(result.secretRead).toBe(false);
    expect(result.configSecretRead).toBe(true);
  }, 240_000);
});
