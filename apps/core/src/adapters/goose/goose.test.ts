import { isAbsolute, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionSpec } from '../adapter.types.ts';
import { READ_ONLY_DENIED } from '../read-only.ts';
import {
  bindGooseEndpoint,
  checkGooseSession,
  GOOSE_CAPS,
  GOOSE_CHANNELS,
  GOOSE_FILES,
  GOOSE_MODE,
  gooseHooksFile,
  gooseLayer,
  gooseReadLayer,
  planGoose,
  refuseGoose,
} from './goose.ts';
import { GOOSE_PERMIT_CODEC, gooseToolName, mapGoosePermission } from './permission.ts';

const HOOK = '"C:\\n\\node.exe" "--experimental-strip-types" "C:\\c\\run.ts" hook';

function spec(over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    sessionId: 's',
    dir: 'C:\\sess\\s1',
    cwd: 'C:\\w',
    brief: 'B',
    deny: { paths: [], commands: [['git', 'push']], mcpTools: [], tools: [] },
    platform: { coreHome: 'C:\\core', tokenFiles: [] },
    tools: 'all',
    mcpServers: {},
    layer: { hooks: 'on', skills: 'on' },
    env: { pin: {} },
    core: {
      taskId: 't',
      stepId: 'st',
      stepKind: 'implement',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'x',
    },
    coreHook: HOOK,
    endpoint: {
      channel: GOOSE_CHANNELS[0]!,
      endpoint: {
        baseUrl: 'http://127.0.0.1:9/',
        dialect: 'openai-chat',
        model: 'stub-model',
        key: 'k',
      },
    },
    ...over,
  };
}

/** Путь внутри каталога сеанса: не выше и не в стороне. */
const inside = (dir: string, file: string): boolean => {
  const rel = relative(dir, join(dir, file));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

describe('goose session files and refusals', () => {
  it('binds the endpoint as the openai provider env of the session only (no files, /v1 path)', () => {
    const got = bindGooseEndpoint(GOOSE_CHANNELS[0]!, spec().endpoint!.endpoint);
    if (!got.ok) throw new Error('bind refused');
    expect(got.binding.files).toEqual({});
    expect(got.binding.argv).toEqual([]);
    expect(got.binding.env).toMatchObject({
      GOOSE_PROVIDER: 'openai',
      OPENAI_HOST: 'http://127.0.0.1:9',
      OPENAI_BASE_PATH: 'v1/chat/completions',
      OPENAI_API_KEY: 'k',
    });
    expect(got.binding.env.GOOSE_MODEL).toMatch(/stub-model/);
    expect(
      bindGooseEndpoint(
        { ...GOOSE_CHANNELS[0]!, dialect: 'anthropic-messages' },
        { ...spec().endpoint!.endpoint, dialect: 'anthropic-messages' },
      ),
    ).toEqual({ ok: false, code: 'no_channel' });
  });

  it('plan: own GOOSE_PATH_ROOT, approve mode, no keyring; the plugin files live under it', () => {
    const s = spec({ mcpServers: { panel: { command: 'x', args: [] } } });
    const plan = planGoose(s, null, gooseLayer(s));
    expect(plan.args).toEqual(['acp']);
    expect(plan.env).toEqual({
      GOOSE_PATH_ROOT: join('C:\\sess\\s1', 'goose-home'),
      GOOSE_MODE: 'approve',
      GOOSE_DISABLE_KEYRING: '1',
      GOOSE_TELEMETRY_OFF: '1',
      GOOSE_SLASH_COMMANDS_ENABLED: 'false',
    });
    expect(Object.keys(plan.files).sort()).toEqual(
      [GOOSE_FILES.config, GOOSE_FILES.hooks, GOOSE_FILES.plugin].sort(),
    );
    for (const file of Object.keys(plan.files)) {
      expect(inside(s.dir, file), file).toBe(true);
      expect(join(s.dir, file).startsWith(plan.env.GOOSE_PATH_ROOT!), file).toBe(true);
    }
    // Плагины Goose ищет в `<GOOSE_PATH_ROOT>/.agents/plugins/<имя>` (проба 02.11).
    for (const file of [GOOSE_FILES.hooks, GOOSE_FILES.plugin]) {
      expect(
        join(s.dir, file).startsWith(join(plan.env.GOOSE_PATH_ROOT!, '.agents', 'plugins')),
      ).toBe(true);
    }
    // Конфиг Goose читает из `<GOOSE_PATH_ROOT>/config/config.yaml` (`goose info -v`, 02.11).
    expect(join(s.dir, GOOSE_FILES.config)).toBe(
      join(plan.env.GOOSE_PATH_ROOT!, 'config', 'config.yaml'),
    );
    // Навыки человека (дом — через ОС, мимо окружения) выключены вместе с расширениями.
    const config = plan.files[GOOSE_FILES.config]!;
    for (const name of ['skills', 'summon']) {
      expect(config).toContain(
        `  ${name}:\n    enabled: false\n    type: platform\n    name: ${name}\n`,
      );
    }
    expect(JSON.parse(plan.files[GOOSE_FILES.plugin]!)).toMatchObject({ name: 'agentdeck' });
    expect(plan.files[GOOSE_FILES.hooks]).toBe(gooseHooksFile(HOOK));
    // Серверы шага идут ACP `session/new` (acp-input), не файлом: потери нет.
    expect(plan.layerLosses).toBeUndefined();
  });

  it('hooks file: PreToolUse for every tool (regex .*), the core hook as is, a crash blocks', () => {
    expect(JSON.parse(gooseHooksFile(HOOK))).toEqual({
      hooks: {
        PreToolUse: [
          { matcher: '.*', hooks: [{ type: 'command', command: HOOK, on_failure: 'block' }] },
        ],
      },
    });
  });

  it('refuses: no core hook, no endpoint (own provider lives in the human config); a resume is judged by its transcript', () => {
    expect(refuseGoose(spec({ coreHook: undefined }))).toMatch(/^no core hook/);
    expect(refuseGoose(spec({ endpoint: undefined }))).toMatch(/routed endpoint/);
    expect(refuseGoose(spec({ resume: { conversationId: 'x' } }))).toBeNull();
    expect(refuseGoose(spec())).toBeNull();
  });

  it('session/new must report the approve mode, anything else fails the handshake', () => {
    expect(GOOSE_MODE).toBe('approve');
    expect(checkGooseSession({ modes: { currentModeId: 'approve' } })).toBeNull();
    expect(checkGooseSession({ modes: { currentModeId: 'auto' } })).toMatch(/goose mode auto/);
    expect(checkGooseSession({})).toMatch(/goose mode undefined/);
  });

  it('layer: the human layer never loads, repo plugins are named; caps claim only the proven', () => {
    expect(gooseLayer(spec())).toMatchObject({
      asked: 'on',
      ran: 'off',
      repoLayer: false,
      detail: expect.stringMatching(
        /skills and summon extensions are off.*repo plugins under \.agents\/plugins still load/,
      ),
      losses: [expect.stringMatching(/no layer control/)],
    });
    expect(gooseLayer(spec({ layer: { hooks: 'off', skills: 'on' } })).losses).toBeUndefined();
    expect(GOOSE_CAPS).toMatchObject({
      preToolHooks: true,
      stream: true,
      attribution: true,
      resume: true,
      // Серверы шага через ACP `session/new`, живая проба goose.mcp (s10 p6).
      mcp: true,
      strictMcp: true,
      denyOverlay: false,
      images: false,
      subagents: false,
      layerControl: false,
    });
  });

  it('read layer: the human goose config and secrets (or the pinned root) are credentials', () => {
    expect(gooseReadLayer({ GOOSE_PATH_ROOT: 'D:\\g' }).credentials).toEqual([
      join('D:\\g', 'config', 'config.yaml'),
      join('D:\\g', 'config', 'secrets.yaml'),
    ]);
    const human = gooseReadLayer({ HOME: '/h', USERPROFILE: 'C:\\h', APPDATA: 'C:\\h\\R' });
    expect(human.credentials).toHaveLength(2);
    expect(human.credentials[0]).toMatch(
      /goose[\\/]config[\\/]?config\.yaml$|goose[\\/]config\.yaml$/,
    );
  });

  it('read-only is decided by the core judge: goose itself has no tool removal', () => {
    const ro = spec({ deny: { ...spec().deny, tools: [...READ_ONLY_DENIED] } });
    expect(planGoose(ro, null, gooseLayer(ro)).env.GOOSE_MODE).toBe('approve');
  });
});

describe('goose permission vocabulary', () => {
  it('shell → exec with argv of the command (system shell dialect)', () => {
    expect(
      mapGoosePermission({ tool: 'shell', input: { command: 'git push origin main' } }),
    ).toMatchObject({
      action: 'exec',
      target: 'git',
      argv: ['git', 'push', 'origin', 'main'],
      tool: 'shell',
      display: 'git push origin main',
    });
  });

  it('text_editor: view is a read, other commands an edit, no path is other; unknown is other', () => {
    expect(
      mapGoosePermission({ tool: 'text_editor', input: { command: 'view', path: 'a.ts' } }),
    ).toMatchObject({
      action: 'read',
      target: 'a.ts',
    });
    expect(
      mapGoosePermission({ tool: 'text_editor', input: { command: 'str_replace', path: 'a.ts' } }),
    ).toMatchObject({ action: 'edit', target: 'a.ts' });
    expect(mapGoosePermission({ tool: 'text_editor', input: { command: 'write' } })).toMatchObject({
      action: 'other',
    });
    expect(mapGoosePermission({ tool: 'todo__write', input: {} })).toMatchObject({
      action: 'other',
      target: 'todo__write',
    });
  });

  it('tool name from the ACP call meta (as the plugin hook sees it), else the title head', () => {
    expect(gooseToolName({ _meta: { goose: { toolCall: { toolName: 'shell' } } } })).toBe('shell');
    expect(gooseToolName({ title: 'text_editor · view a.ts' })).toBe('text_editor');
    expect(gooseToolName({})).toBe('unknown');
  });

  it('permit codec: reads the dialect ask form, renders accept/decline only', () => {
    expect(
      GOOSE_PERMIT_CODEC.read({ tool_name: 'shell', input: { command: 'ls' }, tool_use_id: 'c1' }),
    ).toMatchObject({ call: { tool: 'shell', input: { command: 'ls' } } });
    expect(GOOSE_PERMIT_CODEC.render({ allow: true, input: {} })).toEqual({ decision: 'accept' });
    expect(GOOSE_PERMIT_CODEC.render({ allow: false, message: 'no' })).toEqual({
      decision: 'decline',
    });
  });
});
