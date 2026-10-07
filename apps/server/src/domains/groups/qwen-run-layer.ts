import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import type { GroupLayerDelivered, GroupLayerRefusal } from '@agentdeck/contracts/group-delivery';
import type { GroupScope } from '@agentdeck/contracts/group-sources';
import { QWEN_HOOK_EVENTS, QWEN_TIMEOUT_MAX, QWEN_TIMEOUT_MIN } from '../../lib/qwen-hook.ts';
import { copyRecursive, renameWithRetry, writeJsonFile, writeTextFile } from '../../lib/safe-io.ts';
import {
  buildHookShimSource,
  hookShimCommand,
  hookShimConfig,
  hookShimPath,
} from '../portability/emit/hook-shim.ts';
import { hashDir, memberContent, skillDirFor, type MemberDeps } from './members.ts';
import {
  QWEN_SYSTEM_SETTINGS_ENV,
  baseSystemSettings,
  qwenLayersRoot,
  qwenMcpEntry,
} from './qwen-layer.ts';
import {
  groupHookTimeoutSeconds,
  groupLeaves,
  groupMcpRaw,
  groupRulesText,
  layerDigest,
  mergeGroupEnv,
} from './run-layer-parts.ts';
import type { GroupLayerInput, GroupLayerPlan, GroupLayerWriter } from './run-layer.types.ts';

/**
 * Группы Claude на одном прогоне Qwen Code — слоем системных настроек, без
 * записи в `~/.qwen` и в `~/.claude`.
 *
 * Qwen каталогов Claude не читает, а слоя «на один запуск» у него нет — есть
 * файл системных настроек (`QWEN_CODE_SYSTEM_SETTINGS_PATH`), который сливается
 * с пользовательскими. Через него едут:
 * - MCP-серверы и хуки групп (хук — через переходник нагрузки в каталоге слоя:
 *   скрипт видит поля под именами Claude, как у себя дома);
 * - скиллы — НАТИВНО, корнем `skills.directories` (P5, qwen 0.25 живьём:
 *   системный корень сливается объединением, одноимённый скилл человека
 *   главнее, безопасный режим корень отключает);
 * - правила — `QWEN.md` каталога слоя из `context.includeDirectories`.
 *
 * Права групп НЕ передаются (F3 владельца, v1): синтаксис правил Qwen свой, а
 * перевод вслепую выдал бы права, которых не просили. P6 показал, что списки
 * прав системы и человека объединяются, — отказ от этого не зависит.
 */

/** Хук слоя: событие Qwen, команда человека, таймаут уже в миллисекундах Qwen. */
interface QwenLayerHook {
  event: string;
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

export interface QwenLayerPayload {
  base: Record<string, unknown>;
  /** Текст `QWEN.md` слоя; правил нет — пусто, каталог в контекст не идёт. */
  contextFile: string;
  skills: { id: string; dir: string; hash: string }[];
  mcpServers: Record<string, Record<string, unknown>>;
  hooks: QwenLayerHook[];
}

const HOOK_EVENTS = new Map(QWEN_HOOK_EVENTS.map((event) => [event.name, event.supportsMatcher]));

/** Слой старше этого и не текущий — удаляется при следующей сборке. */
const STALE_LAYER_MS = 7 * 24 * 60 * 60 * 1000;

function objectAt(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Таймаут хука Claude (секунды) → миллисекунды Qwen в его границах: без этого
 * хук на Qwen работал бы на умолчании вместо заданного человеком.
 */
function hookTimeoutMs(deps: MemberDeps, scope: GroupScope, id: string): number | undefined {
  const seconds = groupHookTimeoutSeconds(deps, scope, id);
  if (seconds === undefined) return undefined;
  return Math.min(QWEN_TIMEOUT_MAX, Math.max(QWEN_TIMEOUT_MIN, Math.round(seconds * 1000)));
}

/** Текст `QWEN.md` слоя — общий текст правил групп. */
export const qwenRunContextText = groupRulesText;

function planQwenLayer(
  deps: MemberDeps,
  input: GroupLayerInput,
  options: { env?: NodeJS.ProcessEnv } = {},
): GroupLayerPlan<QwenLayerPayload> {
  const cli = input.cliName;
  const delivered: GroupLayerDelivered[] = [];
  const refused: GroupLayerRefusal[] = [];
  const rules: { group: string; text: string }[] = [];
  const skills: QwenLayerPayload['skills'] = [];
  const mcpServers: QwenLayerPayload['mcpServers'] = {};
  const hooks: QwenLayerHook[] = [];
  // Один участник в двух группах прогона: побеждает первая (порядок —
  // приоритет: выбранная, привязанные, включённые), вторая слышит причину.
  const owner = new Map<string, { id: string; name: string }>();

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
      const entry = qwenMcpEntry(groupMcpRaw(deps, scope, member.id));
      if (!entry) {
        refuse('group-layer-mcp-shape', { id: member.id });
        continue;
      }
      mcpServers[member.id] = entry;
      delivered.push({ group: group.id, member: key });
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
      const hook = JSON.parse(content.text) as { event: string; matcher?: string; command: string };
      const supportsMatcher = HOOK_EVENTS.get(hook.event);
      if (supportsMatcher === undefined) {
        refuse('group-layer-hook-event-native', { cli, event: hook.event });
        continue;
      }
      const timeoutMs = hookTimeoutMs(deps, scope, member.id);
      hooks.push({
        event: hook.event,
        ...(supportsMatcher && hook.matcher ? { matcher: hook.matcher } : {}),
        command: hook.command,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    } else {
      // Вид участника, которого слой не знает, молча не теряется.
      refuse('group-layer-missing', { id: member.id });
      continue;
    }
    delivered.push({ group: group.id, member: key });
  }

  const env = mergeGroupEnv(input.groups);
  const base = baseSystemSettings(options.env ?? process.env);
  const contextFile = qwenRunContextText(rules);
  const allRefused = [...refused, ...env.refused];
  const digest = layerDigest({
    kind: 'qwen-system-settings',
    base,
    contextFile,
    mcpServers,
    hooks,
    skills: skills.map((skill) => [skill.id, skill.hash]),
    env: env.env,
    // Состав заметки: та же группа с новым отказом — новая строка в ленте.
    groups: input.groups.map((group) => group.name),
    refused: allRefused.map((item) => [item.member, item.code]),
  });
  return {
    kind: 'qwen-system-settings',
    providerId: input.providerId,
    groups: input.groups.map((group) => ({ id: group.id, name: group.name })),
    delivered: [...delivered, ...env.delivered],
    refused: allRefused,
    env: env.env,
    digest,
    payload: { base, contextFile, skills, mcpServers, hooks },
  };
}

/** Системные настройки слоя поверх тех, что уже стоят на машине. */
function layerSettings(payload: QwenLayerPayload, dir: string): Record<string, unknown> {
  const { base } = payload;
  const settings: Record<string, unknown> = { ...base };
  if (Object.keys(payload.mcpServers).length) {
    settings.mcpServers = { ...objectAt(base.mcpServers), ...payload.mcpServers };
  }
  if (payload.hooks.length) {
    const merged: Record<string, unknown> = { ...objectAt(base.hooks) };
    for (const hook of payload.hooks) {
      const config = hookShimConfig({ event: hook.event, command: hook.command });
      const prior = Array.isArray(merged[hook.event]) ? (merged[hook.event] as unknown[]) : [];
      merged[hook.event] = [
        ...prior,
        {
          ...(hook.matcher ? { matcher: hook.matcher } : {}),
          hooks: [
            {
              type: 'command',
              command: hookShimCommand(hookShimPath(join(dir, 'hooks'), config)),
              ...(hook.timeoutMs !== undefined ? { timeout: hook.timeoutMs } : {}),
            },
          ],
        },
      ];
    }
    settings.hooks = merged;
  }
  if (payload.skills.length) {
    const skillsBase = objectAt(base.skills);
    const roots = Array.isArray(skillsBase.directories) ? skillsBase.directories : [];
    settings.skills = { ...skillsBase, directories: [...roots, join(dir, 'skills')] };
  }
  if (payload.contextFile) {
    const context = objectAt(base.context);
    const included = Array.isArray(context.includeDirectories) ? context.includeDirectories : [];
    settings.context = {
      ...context,
      includeDirectories: [...included, dir],
      loadFromIncludeDirectories: true,
    };
  }
  return settings;
}

function writeQwenLayer(
  deps: MemberDeps,
  plan: GroupLayerPlan<QwenLayerPayload>,
  options: { now?: number } = {},
): { env: Record<string, string>; dir: string } | undefined {
  const { payload } = plan;
  const fileBorne =
    payload.skills.length + payload.hooks.length + Object.keys(payload.mcpServers).length;
  if (fileBorne === 0 && !payload.contextFile) {
    // Доставлять файлом нечего: переменные групп едут окружением, без слоя.
    return Object.keys(plan.env).length ? { env: { ...plan.env }, dir: '' } : undefined;
  }
  const root = qwenLayersRoot(deps.paths.appData);
  // Каталог — по содержимому: два прогона одних групп делят его, и ни один не
  // перезаписывает файл, который в эту секунду читает уже запущенный CLI.
  const dir = join(root, plan.digest);
  const now = options.now ?? Date.now();
  if (!existsSync(join(dir, 'system-settings.json'))) {
    const staging = join(root, `.${plan.digest}-${randomUUID().slice(0, 8)}`);
    mkdirSync(staging, { recursive: true });
    for (const skill of payload.skills) copyRecursive(skill.dir, join(staging, 'skills', skill.id));
    if (payload.contextFile) writeTextFile(join(staging, 'QWEN.md'), payload.contextFile);
    for (const hook of payload.hooks) {
      const config = hookShimConfig({ event: hook.event, command: hook.command });
      // Путь в настройках — итоговый (`dir`), файл ложится в черновик и переезжает с ним.
      writeTextFile(hookShimPath(join(staging, 'hooks'), config), buildHookShimSource(config));
    }
    writeJsonFile(join(staging, 'system-settings.json'), layerSettings(payload, dir));
    // Каталог без файла настроек — недописанный прошлый (сбой посреди сборки).
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    try {
      renameWithRetry(staging, dir);
    } catch {
      // Соседний прогон успел первым — его каталог того же содержимого.
      rmSync(staging, { recursive: true, force: true });
    }
  } else {
    // Слой в ходу: свежая метка не даёт уборке снести его под работающим CLI.
    const stamp = new Date(now);
    utimesSync(dir, stamp, stamp);
  }
  pruneStaleLayers(root, plan.digest, now);
  return {
    env: { ...plan.env, [QWEN_SYSTEM_SETTINGS_ENV]: join(dir, 'system-settings.json') },
    dir,
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

/** Писатель слоя Qwen для реестра `run-layer.ts`. */
export const qwenGroupLayerWriter: GroupLayerWriter<QwenLayerPayload> = {
  kind: 'qwen-system-settings',
  plan: planQwenLayer,
  write: (deps, plan, options) => writeQwenLayer(deps, plan, options),
};
