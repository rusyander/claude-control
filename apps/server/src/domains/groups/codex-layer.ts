import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import type { GroupLayerDelivered, GroupLayerRefusal } from '@agentdeck/contracts/group-delivery';
import { copyRecursive, renameWithRetry, writeJsonFile } from '../../lib/safe-io.ts';
import { codexHome } from '../../providers/catalog/config-dirs.ts';
import {
  CODEX_GROUP_ENV,
  CODEX_KIT_ARG_LIMIT,
  codexInstructionsLength,
  codexSkillIndex,
  codexSkillLine,
  codexSkillLines,
  ownDeveloperInstructions,
  type CodexGroupOverlay,
} from '../kit/codex.ts';
import { hashDir, memberContent, skillDirFor, type MemberDeps } from './members.ts';
import {
  GroupLayerBlocked,
  groupHookTimeoutSeconds,
  groupLeaves,
  groupMcpRaw,
  groupRulesText,
  layerDigest,
  mergeGroupEnv,
} from './run-layer-parts.ts';
import type {
  GroupLayerHook,
  GroupLayerInput,
  GroupLayerPlan,
  GroupLayerWriter,
} from './run-layer.types.ts';

/**
 * Группы Claude на одном прогоне Codex — накладкой поверх его конфига, без
 * записи в `~/.codex` и в `~/.claude` (F4 владельца, 06.10.2026).
 *
 * - Правила — в тот же `-c developer_instructions=…`, что и набор панели:
 *   собственный текст человека, потом набор, потом группы (`withCodexKit`).
 * - Скиллы — копией в каталог слоя: у `app-server` это корень
 *   `skills/extraRoots/set`, у `exec` — строки списка в инструкциях.
 * - MCP — `-c mcp_servers.<id>={…}` (сливается с `config.toml`). Значения
 *   секретов — ТОЛЬКО в окружении процесса: stdio получает их по имени через
 *   `env_vars`, http-заголовки — через `env_http_headers` (P2, codex 0.160
 *   живьём: оба доходят, а прочие переменные stdio-сервер не наследует). В
 *   командной строке и в файлах слоя — одни имена.
 * - Хуки — надзирателем панели (`owner: 'layer'`): хук в файлах Codex
 *   срабатывает только после одобрения в `/hooks`, а слой в них не пишет.
 *   Отыгрываются начало сессии, отправка и конец ответа; события инструментов
 *   ждут калитки инструментов и честно отказаны.
 * - Права групп не переносятся: у Codex своя схема (как у Qwen, F3).
 */

const STALE_LAYER_MS = 7 * 24 * 60 * 60 * 1000;
/** Codex не грузит скилл с именем длиннее (проверено CLI, provider-formats). */
const SKILL_NAME_MAX = 64;
/** Голый ключ TOML: точка или пробел сделали бы из имени вложенную таблицу. */
const BARE_KEY = /^[A-Za-z0-9_-]+$/;
/** Имя переменной окружения, которую Codex передаёт серверу. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLAYED_EVENTS: ReadonlySet<string> = new Set(['SessionStart', 'UserPromptSubmit', 'Stop']);

export interface CodexLayerPayload {
  rules: string;
  skills: { id: string; dir: string; hash: string }[];
  /** Аргументы `-c mcp_servers.…` — только имена переменных, без значений. */
  mcpArgs: string[];
  /** Значения секретов MCP под их именами — уходят в окружение процесса. */
  secrets: Record<string, string>;
  hooks: GroupLayerHook[];
}

/** Строка TOML: строка JSON — допустимая базовая строка TOML. */
const tomlString = (value: string): string => JSON.stringify(value);

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, item]) => typeof item !== 'string')) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Имя переменной для значения заголовка: своё пространство панели. */
function headerEnvName(id: string, header: string): string {
  const part = (text: string): string => text.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `AGENTDECK_MCP_${part(id)}_${part(header)}`;
}

type McpResult =
  | { ok: true; arg: string; secrets: Record<string, string> }
  | { ok: false; code: GroupLayerRefusal['code']; params: Record<string, string> };

/** Запись MCP Claude → аргумент Codex и секреты отдельно. */
function codexMcp(id: string, raw: unknown): McpResult {
  if (!BARE_KEY.test(id)) return { ok: false, code: 'group-layer-mcp-name', params: { id } };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'group-layer-mcp-shape', params: { id } };
  }
  const entry = raw as Record<string, unknown>;
  const type = entry.type ?? (typeof entry.command === 'string' ? 'stdio' : undefined);
  if (type === 'sse') return { ok: false, code: 'group-layer-mcp-sse', params: { id } };
  if (type === 'stdio' && typeof entry.command === 'string') {
    const args = Array.isArray(entry.args) ? entry.args : [];
    const env = entry.env === undefined ? {} : stringRecord(entry.env);
    if (!env || args.some((arg) => typeof arg !== 'string')) {
      return { ok: false, code: 'group-layer-mcp-shape', params: { id } };
    }
    if (Object.keys(env).some((name) => !ENV_NAME.test(name))) {
      return { ok: false, code: 'group-layer-mcp-shape', params: { id } };
    }
    const fields = [
      `command=${tomlString(entry.command)}`,
      ...(args.length ? [`args=[${(args as string[]).map(tomlString).join(',')}]`] : []),
      ...(Object.keys(env).length
        ? [`env_vars=[${Object.keys(env).map(tomlString).join(',')}]`]
        : []),
    ];
    return { ok: true, arg: `mcp_servers.${id}={${fields.join(',')}}`, secrets: env };
  }
  if (type === 'http' && typeof entry.url === 'string') {
    const headers = entry.headers === undefined ? {} : stringRecord(entry.headers);
    if (!headers) return { ok: false, code: 'group-layer-mcp-shape', params: { id } };
    const secrets: Record<string, string> = {};
    const mapping = Object.entries(headers).map(([header, value]) => {
      const name = headerEnvName(id, header);
      secrets[name] = value;
      return `${tomlString(header)}=${tomlString(name)}`;
    });
    const fields = [
      `url=${tomlString(entry.url)}`,
      ...(mapping.length ? [`env_http_headers={${mapping.join(',')}}`] : []),
    ];
    return { ok: true, arg: `mcp_servers.${id}={${fields.join(',')}}`, secrets };
  }
  return { ok: false, code: 'group-layer-mcp-shape', params: { id } };
}

function planCodexLayer(
  deps: MemberDeps,
  input: GroupLayerInput,
  options: { env?: NodeJS.ProcessEnv } = {},
): GroupLayerPlan<CodexLayerPayload> {
  const cli = input.cliName;
  const delivered: GroupLayerDelivered[] = [];
  const refused: GroupLayerRefusal[] = [];
  const rules: { group: string; text: string }[] = [];
  const skills: CodexLayerPayload['skills'] = [];
  const mcpArgs: string[] = [];
  const secrets: Record<string, string> = {};
  const hooks: GroupLayerHook[] = [];
  const owner = new Map<string, { id: string; name: string }>();
  const secretOwner = new Map<string, string>();

  for (const { group, member, scope } of groupLeaves(deps.store.getGroups(), input.groups)) {
    const key = `${member.kind}:${member.id}`;
    const refuse = (code: GroupLayerRefusal['code'], params: Record<string, string>): void => {
      refused.push({ group: group.id, member: key, code, params });
    };
    const first = owner.get(key);
    if (first !== undefined) {
      if (first.id !== group.id)
        refuse('group-layer-duplicate', { id: member.id, group: first.name });
      continue;
    }
    owner.set(key, { id: group.id, name: group.name });

    if (member.kind === 'permission') {
      refuse('group-layer-permission', { cli });
      continue;
    }
    if (member.kind === 'mcp') {
      const result = codexMcp(member.id, groupMcpRaw(deps, scope, member.id));
      if (!result.ok) {
        refuse(result.code, result.params);
        continue;
      }
      // Два сервера с одним именем переменной и разными значениями: процесс у
      // Codex один, и второе значение молча подменило бы первое.
      const clash = Object.entries(result.secrets).find(
        ([name, value]) => secretOwner.has(name) && secrets[name] !== value,
      );
      if (clash) {
        refuse('group-layer-duplicate', { id: clash[0], group: secretOwner.get(clash[0]) ?? '' });
        continue;
      }
      for (const [name, value] of Object.entries(result.secrets)) {
        secrets[name] = value;
        secretOwner.set(name, group.name);
      }
      mcpArgs.push(result.arg);
      delivered.push({ group: group.id, member: key });
      continue;
    }
    if (member.kind === 'skill' && member.id.length > SKILL_NAME_MAX) {
      refuse('group-layer-skill-name', { id: member.id });
      continue;
    }
    const content = memberContent(deps, scope, member);
    if (!content) {
      refuse('group-layer-missing', { id: member.id });
      continue;
    }
    if (member.kind === 'rule') {
      rules.push({ group: group.name, text: content.text.trim() });
    } else if (member.kind === 'skill') {
      const dir = skillDirFor(deps.paths, scope, member.id);
      if (!dir) {
        refuse('group-layer-missing', { id: member.id });
        continue;
      }
      skills.push({ id: member.id, dir, hash: hashDir(dir) });
    } else if (member.kind === 'hook') {
      const hook = JSON.parse(content.text) as { event: string; command: string };
      if (!PLAYED_EVENTS.has(hook.event)) {
        refuse('group-layer-hook-event', { cli, event: hook.event });
        continue;
      }
      const seconds = groupHookTimeoutSeconds(deps, scope, member.id);
      hooks.push({
        event: hook.event as GroupLayerHook['event'],
        command: hook.command,
        ...(seconds !== undefined ? { timeoutMs: Math.round(seconds * 1000) } : {}),
      });
    } else {
      refuse('group-layer-missing', { id: member.id });
      continue;
    }
    delivered.push({ group: group.id, member: key });
  }

  const env = mergeGroupEnv(input.groups);
  // Переменная группы с именем секрета MCP и другим значением: процесс один,
  // значение одно — секрет сервера главнее, переменная слышит причину.
  for (const [name, value] of Object.entries(env.env)) {
    if (!(name in secrets) || secrets[name] === value) continue;
    delete env.env[name];
    const member = `env:${name}`;
    const at = env.delivered.findIndex((item) => item.member === member);
    const [lost] = at >= 0 ? env.delivered.splice(at, 1) : [];
    env.refused.push({
      group: lost?.group ?? '',
      member,
      code: 'group-layer-duplicate',
      params: { id: name, group: secretOwner.get(name) ?? '' },
    });
  }
  const rulesText = groupRulesText(rules);
  // Набор панели решается при запуске; здесь — свой текст человека и группы:
  // уже это не помещается — прогон отказан сразу, ничего не обрезано.
  const home = options.env?.CODEX_HOME || codexHome();
  const own = ownDeveloperInstructions(home);
  const index = codexSkillIndex(
    skills.map((skill) => codexSkillLine(skill.id, skill.dir, join(skill.dir, 'SKILL.md'))),
    'agentdeck group skills',
  );
  if (codexInstructionsLength([own, rulesText, index]) > CODEX_KIT_ARG_LIMIT) {
    throw new GroupLayerBlocked('group-layer-too-large', { limit: String(CODEX_KIT_ARG_LIMIT) });
  }
  const allRefused = [...refused, ...env.refused];
  const digest = layerDigest({
    kind: 'codex-overlay',
    rulesText,
    mcpArgs,
    // Значения — только отпечатком: сменился секрет — новый каталог, а не старый.
    secrets: layerDigest(secrets),
    hooks,
    skills: skills.map((skill) => [skill.id, skill.hash]),
    env: env.env,
    groups: input.groups.map((group) => group.name),
    refused: allRefused.map((item) => [item.member, item.code]),
  });
  return {
    kind: 'codex-overlay',
    providerId: input.providerId,
    groups: input.groups.map((group) => ({ id: group.id, name: group.name })),
    delivered: [...delivered, ...env.delivered],
    refused: allRefused,
    env: env.env,
    digest,
    payload: { rules: rulesText, skills, mcpArgs, secrets, hooks },
  };
}

export function codexLayersRoot(appData: string): string {
  return join(appData, 'codex-group-layers');
}

function writeCodexLayer(
  deps: MemberDeps,
  plan: GroupLayerPlan<CodexLayerPayload>,
  options: { now?: number } = {},
): { env: Record<string, string>; dir: string; hooks?: GroupLayerHook[] } | undefined {
  const { payload } = plan;
  const hooks = payload.hooks.length ? { hooks: [...payload.hooks] } : {};
  const fileBorne = payload.rules || payload.skills.length || payload.mcpArgs.length;
  if (!fileBorne) {
    const env = { ...plan.env };
    return Object.keys(env).length || payload.hooks.length ? { env, dir: '', ...hooks } : undefined;
  }
  const root = codexLayersRoot(deps.paths.appData);
  const dir = join(root, plan.digest);
  const file = join(dir, 'overlay.json');
  const now = options.now ?? Date.now();
  if (!existsSync(file)) {
    const staging = join(root, `.${plan.digest}-${randomUUID().slice(0, 8)}`);
    mkdirSync(staging, { recursive: true });
    for (const skill of payload.skills) copyRecursive(skill.dir, join(staging, 'skills', skill.id));
    const skillsDir = join(dir, 'skills');
    const overlay: CodexGroupOverlay = {
      rules: payload.rules,
      skillIndex: codexSkillIndex(
        codexSkillLines(join(staging, 'skills')).map((line) => ({
          ...line,
          path: join(skillsDir, line.name, 'SKILL.md'),
        })),
        'agentdeck group skills',
      ),
      ...(payload.skills.length ? { skillsDir } : {}),
      mcpArgs: payload.mcpArgs,
      secretNames: Object.keys(payload.secrets),
    };
    // В файле — одни имена переменных: значения живут только в окружении процесса.
    writeJsonFile(join(staging, 'overlay.json'), overlay);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    try {
      renameWithRetry(staging, dir);
    } catch {
      rmSync(staging, { recursive: true, force: true });
    }
  } else {
    const stamp = new Date(now);
    utimesSync(dir, stamp, stamp);
  }
  pruneStaleLayers(root, plan.digest, now);
  return {
    env: { ...plan.env, ...payload.secrets, [CODEX_GROUP_ENV]: file },
    dir,
    ...hooks,
  };
}

function pruneStaleLayers(root: string, keep: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === keep) continue;
    const path = join(root, name);
    try {
      if (now - statSync(path).mtimeMs > STALE_LAYER_MS)
        rmSync(path, { recursive: true, force: true });
    } catch {
      // Каталог держит работающий CLI — уйдёт в следующий раз.
    }
  }
}

/** Писатель слоя Codex для реестра `run-layer.ts`. */
export const codexGroupLayerWriter: GroupLayerWriter<CodexLayerPayload> = {
  kind: 'codex-overlay',
  plan: planCodexLayer,
  write: (deps, plan, options) => writeCodexLayer(deps, plan, options),
};
