import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionSpec } from '../adapter.types.ts';
import { resolveLayer } from '../sdk-stream/layer-run.ts';
import {
  CLAUDE_CHANNELS,
  CLAUDE_LAYER,
  createClaudeAdapter,
  planClaude,
  refuseClaude,
} from './claude.ts';

/**
 * Набор панели в недоверенной папке (s10 G13, дефект G11). Прежде любой ход чата ядра в проекте
 * без отметки доверия CLI отказывал до модели: набор всегда несёт плагин стражей, а снижение `on`
 * до `observe` недоверием отказывало плагины. Прежняя панель (`claude -p` доверия не спрашивает)
 * ставила набор в любом проекте — его каталог панели, не репозитория.
 *
 * Путь — тот же, что у `launch` переходника: настоящая запись доверия CLI из конфига пина
 * (`resolveLayer` + `CLAUDE_LAYER`), отказ, план. Запуск CLI не нужен: в проверке запуска сеанс
 * останавливает подставная ручка модели сразу ПОСЛЕ отказа слоя — так видно, что отказ пройден.
 */

function stand(): { cwd: string; config: string; kit: string } {
  const root = mkdtempSync(join(tmpdir(), 'claude-plugin-carry-'));
  const cwd = join(root, 'project');
  const config = join(root, 'cfg');
  const kit = join(root, 'appdata', 'kit', 'composed');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(config, { recursive: true });
  mkdirSync(join(kit, '.claude-plugin'), { recursive: true });
  writeFileSync(join(kit, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit' }));
  return { cwd, config, kit };
}

function spec(
  s: ReturnType<typeof stand>,
  over: Partial<SessionSpec> = {},
  hooks: SessionSpec['layer']['hooks'] = 'on',
): SessionSpec {
  return {
    sessionId: '44444444-4444-4444-8444-444444444444',
    dir: join(s.cwd, '..', 'session'),
    cwd: s.cwd,
    brief: 'BRIEF',
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platform: { coreHome: join(s.cwd, '..', 'core'), tokenFiles: [] },
    tools: 'all',
    mcpServers: {},
    layer: {
      hooks,
      skills: 'on',
      carry: { plugins: [s.kit], settingSources: ['project', 'local'] },
    },
    env: { pin: { CLAUDE_CONFIG_DIR: s.config } },
    coreHook: 'node core.mjs',
    recorder: { command: 'node rec.mjs', log: join(s.cwd, '..', 'rec.jsonl') },
    core: {
      taskId: 't',
      stepId: 's',
      stepKind: 'implement',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'tok',
    },
    trust: { sourceRepo: s.cwd, panelMark: false },
    ...over,
  };
}

/** Ручка модели, которую Claude не свяжет (`no_channel`): запуск встаёт сразу после отказа слоя. */
const UNBINDABLE: SessionSpec['endpoint'] = {
  channel: { ...CLAUDE_CHANNELS[0]!, via: 'file' } as never,
  endpoint: {
    baseUrl: 'http://127.0.0.1:9',
    dialect: 'anthropic-messages',
    model: 'stub-model',
    key: 'k-1',
  },
};

describe('claude plugin carry — набор панели и доверие к папке (G13)', () => {
  it('проект без отметки доверия: слой `observe`, плагин набора едет, источники — `` ядра, отказа нет', async () => {
    const s = stand();
    const untrusted = spec(s);
    const layer = await resolveLayer(untrusted, CLAUDE_LAYER);
    expect(layer).toMatchObject({ asked: 'on', ran: 'observe', repoLayer: false, trust: 'none' });
    expect(refuseClaude(untrusted, {}, layer)).toBeNull();
    const args = planClaude(untrusted, null, layer).args;
    const plugins = args.flatMap((a, i) => (a === '--plugin-dir' ? [args[i + 1]] : []));
    expect(plugins).toContain(s.kit);
    const sources = args.flatMap((a, i) => (a === '--setting-sources' ? [args[i + 1]] : []));
    expect(sources).toEqual(['']);
  });

  it('запуск переходника: недоверенный проект проходит отказ слоя (встаёт на ручке модели)', async () => {
    const s = stand();
    const outcome = await createClaudeAdapter().launch(spec(s, { endpoint: UNBINDABLE }));
    expect(outcome).toEqual({ ok: false, reason: 'endpoint refused: no_channel' });
  });

  it('доверенный проект (запись CLI): `on`, сужение набора `project,local` как было', async () => {
    const s = stand();
    writeFileSync(
      join(s.config, '.claude.json'),
      JSON.stringify({
        projects: { [s.cwd.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true } },
      }),
    );
    const trusted = spec(s);
    const layer = await resolveLayer(trusted, CLAUDE_LAYER);
    expect(layer).toMatchObject({ ran: 'on', trust: 'cli' });
    const args = planClaude(trusted, null, layer).args;
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project,local');
  });

  it('`observe`, попрошенный самим шагом, — отказ по имени и при запуске', async () => {
    const s = stand();
    const stepObserve = spec(s, { trust: { sourceRepo: s.cwd, panelMark: true } }, 'observe');
    const layer = await resolveLayer(stepObserve, CLAUDE_LAYER);
    expect(layer).toMatchObject({ asked: 'observe', ran: 'observe', trust: 'panel' });
    expect(refuseClaude(stepObserve, {}, layer)).toMatch(/^session-carry-needs-layer-on:/);
    await expect(createClaudeAdapter().launch(stepObserve)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^session-carry-needs-layer-on:/),
    });
  });

  it('недоверенный проект не снимает проверку каталога: плагин с MCP — отказ', async () => {
    const s = stand();
    writeFileSync(join(s.kit, '.mcp.json'), '{}');
    const untrusted = spec(s);
    const layer = await resolveLayer(untrusted, CLAUDE_LAYER);
    expect(refuseClaude(untrusted, {}, layer)).toMatch(
      /^session-carry-plugin: plugin declares MCP/,
    );
  });
});
