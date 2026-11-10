import { join } from 'node:path';
import { cursorRunFacts } from '@agentdeck/providers/cursor';
import type {
  AdapterCaps,
  BindOutcome,
  EndpointBinding,
  LayerRun,
  ReadLayer,
  SessionSpec,
} from '../adapter.types.ts';
import { ACP_PERMIT_CODEC } from '../acp-input.ts';
import { economyRefused, withLosses } from '../economy-carry.ts';
import { createGatelessAdapter } from '../gateless.ts';
import type { CliAdapter } from '../adapter.types.ts';
import { createAcpDialect, type AcpDialectData } from '../rpc-stdio/acp.ts';
import {
  createRpcAdapter,
  type RpcAdapter,
  type RpcAdapterOptions,
} from '../rpc-stdio/rpc-adapter.ts';
import type { SdkLaunchPlan } from '../sdk-stream/sdk-adapter.ts';
import { homeDir } from '../../platform/os-kind.ts';
import { cursorToolName, mapCursorPermission } from './permission.ts';

/**
 * Cursor Agent: входа Cursor на машине нет, живой CLI не запускался — хук `preToolUse` не доказан
 * (P81 требует живого отказа push). Поэтому в реестре стоит переходник без судьи (`no_core_hook`,
 * Q8), а настоящий переходник поверх ACP (`cursor-agent acp`) — `createCursorRpcAdapter`, код и
 * подставной CLI (`__fixtures__/fake-cursor-agent.mjs`), без единой объявленной возможности.
 *
 * Сеанс: дом CLI свой (`HOME`/`USERPROFILE` = `<сеанс>/cursor-home`; переменной папки настроек
 * документация Cursor не называет — не выдумываем), хук ядра — `.cursor/hooks.json` там же (`preToolUse`, `failClosed: true`: упавший хук — отказ). Канала адреса
 * у Cursor нет (своего API нет, переменной адреса документация не называет) — маршрут с адресом
 * модели отказан, вход — свой у CLI (ключ `CURSOR_API_KEY` из окружения сеанса).
 */

const HOME = 'cursor-home';

export const CURSOR_FILES = { hooks: `${HOME}/.cursor/hooks.json` } as const;

/** Все возможности выключены: ни одна не доказана на живом CLI (P121). */
export const CURSOR_CAPS: AdapterCaps = {
  resume: false,
  mcp: false,
  strictMcp: false,
  permissionTool: false,
  denyOverlay: false,
  preToolHooks: false,
  layerControl: false,
  attribution: false,
  stream: false,
  effort: false,
  images: false,
  subagents: false,
  skillControl: false,
  subagentHooks: false,
  login: cursorRunFacts.login,
  channels: [],
  windowEvent: false,
  limitsChannel: null,
  // Потерю входа (этап 12, P170) не называет: текста и чтения входа в наборе соответствия нет.
  loginLost: false,
};

/** Канала адреса у Cursor нет: любой адрес отказан. */
export function bindCursorEndpoint(): BindOutcome {
  return { ok: false, code: 'no_channel' };
}

/** Дом Cursor человека: вход и настройки CLI судья не даёт читать. */
export function cursorReadLayer(pin: Record<string, string>): ReadLayer {
  const home = homeDir(pin);
  const config = join(home, '.cursor');
  return {
    dirs: [],
    credentials: [
      join(config, 'cli-config.json'),
      join(config, 'mcp.json'),
      join(home, '.config', 'cursor', 'auth.json'),
    ],
  };
}

export function cursorLayer(spec: SessionSpec): LayerRun {
  const asked = spec.layer.hooks;
  return {
    asked,
    ran: 'off',
    repoLayer: false,
    trust: 'none',
    detail: 'cursor: per-session HOME, the human hooks, rules and MCP do not load',
    ...(asked === 'off' ? {} : { losses: [`hooks ${asked} -> off: cursor has no layer control`] }),
  };
}

export function refuseCursor(spec: SessionSpec): string | null {
  if (!spec.coreHook) return 'no core hook: the session would run without the core preToolUse hook';
  if (spec.endpoint) return 'cursor has no endpoint channel: a routed model cannot reach it';
  if (spec.resume) return 'cursor adapter does not resume a conversation';
  return null;
}

/** `hooks.json` сеанса: хук ядра до каждого вызова, сбой хука — отказ. */
export function cursorHooksFile(coreHook: string): string {
  return `${JSON.stringify(
    { version: 1, hooks: { preToolUse: [{ command: coreHook, failClosed: true }] } },
    null,
    2,
  )}\n`;
}

/**
 * Почему MCP шага Cursor не получает (s10 p11): обе двери не доказаны. ACP `session/new` несёт поле
 * `mcpServers`, но берёт ли его `cursor-agent acp` — не видел ни один живой прогон (входа Cursor
 * нет); свой файл CLI `.cursor/mcp.json` можно положить в дом сеанса, но читает ли его режим `acp`
 * и не спросит ли агент одобрения сервера посреди шага — без живого CLI неизвестно. Подставной CLI
 * доказал бы только наше допущение — поэтому переходник шлёт `mcpServers: []`, а потеря названа
 * поимённо.
 */
export const CURSOR_MCP_UNPROVEN =
  'cursor-agent never ran live here: neither ACP session/new mcpServers nor a session .cursor/mcp.json is proven to start a server without a prompt';

export function planCursor(
  spec: SessionSpec,
  _binding: EndpointBinding | null,
  _layer: LayerRun,
): SdkLaunchPlan {
  const home = join(spec.dir, HOME);
  const losses = Object.keys(spec.mcpServers);
  return {
    args: ['acp'],
    env: { HOME: home, USERPROFILE: home },
    files: { [CURSOR_FILES.hooks]: cursorHooksFile(spec.coreHook as string) },
    ...withLosses([
      ...(losses.length > 0
        ? [`mcp servers not carried (${CURSOR_MCP_UNPROVEN}): ${losses.join(', ')}`]
        : []),
      ...economyRefused(spec, 'cursor agent has no per-run key for it').lost,
    ]),
  };
}

/** Переходник поверх ACP: код и подставной CLI, в реестр не входит до живого доказательства. */
export function createCursorRpcAdapter(options: RpcAdapterOptions = {}): RpcAdapter {
  return createRpcAdapter(
    {
      id: cursorRunFacts.id,
      caps: CURSOR_CAPS,
      command: cursorRunFacts.binary.command,
      readLayer: cursorReadLayer,
      bindEndpoint: bindCursorEndpoint,
      layer: cursorLayer,
      refuse: refuseCursor,
      plan: planCursor,
      dialectInput: ({ spec, permit }): AcpDialectData => ({
        cli: cursorRunFacts.id,
        cwd: spec.cwd,
        permit,
      }),
      dialect: (data) =>
        createAcpDialect({
          ...data,
          mapPermission: mapCursorPermission,
          toolName: cursorToolName,
        }),
      mapPermission: mapCursorPermission,
      permitCodec: ACP_PERMIT_CODEC,
    },
    options,
  );
}

/** Строка реестра: без живого доказательства хука запуск отказан `no_core_hook`. */
export function createCursorAdapter(): CliAdapter {
  return createGatelessAdapter(
    cursorRunFacts,
    'preToolUse hook unproven on a live cursor-agent (no Cursor account); the ACP adapter is code and a fake CLI only',
  );
}
