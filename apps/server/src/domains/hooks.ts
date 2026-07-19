import { existsSync, readFileSync } from 'node:fs';
import type { Hook, HookDraft, HookEvent } from '@claude-control/contracts';
import { readJsonFile, writeJsonFile } from '../lib/safe-io.ts';
import type { AppStore } from '../lib/app-store.ts';
import { generateHookScript } from './hook-scripts.ts';

/**
 * В settings.json хуки лежат в три уровня: событие → группы matcher → команды.
 * Для списка и редактирования это неудобно, поэтому разворачиваем структуру
 * в плоский список, а при сохранении собираем обратно ровно в том формате,
 * который понимает Claude Code.
 */

interface RawHookCommand {
  type: string;
  command: string;
  timeout?: number;
}

interface RawMatcherGroup {
  matcher?: string;
  hooks: RawHookCommand[];
}

interface RawSettings {
  hooks?: Record<string, RawMatcherGroup[]>;
  [key: string]: unknown;
}

export function readHooks(settingsPath: string, store: AppStore): Hook[] {
  const settings = readJsonFile<RawSettings>(settingsPath, {});
  const result: Hook[] = [];

  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    groups.forEach((group, groupIndex) => {
      group.hooks.forEach((command, commandIndex) => {
        const id = `${event}:${groupIndex}:${commandIndex}`;
        const scriptPath = extractScriptPath(command.command);

        result.push({
          id,
          event: event as HookEvent,
          matcher: group.matcher,
          command: command.command,
          timeout: command.timeout,
          isEnabled: !store.isDisabled('hook', id),
          scriptPath,
          scriptExists: scriptPath ? existsSync(scriptPath) : undefined,
          description: scriptPath ? readScriptDescription(scriptPath) : undefined,
          groupIds: store.getGroupIdsFor('hook', id),
        });
      });
    });
  }

  return result;
}

/** Собирает плоский список обратно во вложенную структуру settings.json. */
export function writeHooks(
  settingsPath: string,
  hooks: Hook[],
  backupDir?: string,
): string | undefined {
  const settings = readJsonFile<RawSettings>(settingsPath, {});
  const grouped: Record<string, RawMatcherGroup[]> = {};

  // Выключенные хуки в файл не попадают — их команды хранит состояние приложения.
  for (const hook of hooks.filter((item) => item.isEnabled)) {
    const groups = (grouped[hook.event] ??= []);
    // Хуки с одинаковым matcher объединяем в одну группу — так же,
    // как это делает сам Claude Code.
    const existing = groups.find((group) => group.matcher === hook.matcher);
    const command: RawHookCommand = { type: 'command', command: hook.command };
    if (hook.timeout !== undefined) command.timeout = hook.timeout;

    if (existing) existing.hooks.push(command);
    else
      groups.push(
        hook.matcher ? { matcher: hook.matcher, hooks: [command] } : { hooks: [command] },
      );
  }

  settings.hooks = grouped;
  return writeJsonFile(settingsPath, settings, { backupDir });
}

export function upsertHook(
  settingsPath: string,
  hooksDir: string,
  hookId: string | null,
  draft: HookDraft,
  store: AppStore,
  backupDir?: string,
): string | undefined {
  const hooks = readHooks(settingsPath, store);
  const index = hookId ? hooks.findIndex((hook) => hook.id === hookId) : -1;

  // Если указано имя скрипта, файл создаётся автоматически, а команда
  // собирается из пути к нему: пользователю не нужно ни создавать файл,
  // ни помнить синтаксис запуска.
  const generated = draft.scriptName?.trim()
    ? generateHookScript(hooksDir, draft, backupDir)
    : undefined;

  const command = generated?.command ?? draft.command;
  // Несколько фильтров объединяются в одно регулярное выражение —
  // именно такой формат понимает Claude Code.
  const matcher = draft.matchers.filter(Boolean).join('|') || undefined;

  const next: Hook = {
    id: hookId ?? `${draft.event}:new:${Date.now()}`,
    event: draft.event,
    matcher,
    command,
    timeout: draft.timeout,
    isEnabled: draft.isEnabled,
    scriptPath: generated?.path ?? extractScriptPath(command),
    groupIds: draft.groupIds,
  };

  if (index >= 0) hooks[index] = next;
  else hooks.push(next);

  return writeHooks(settingsPath, hooks, backupDir);
}

export function deleteHook(
  settingsPath: string,
  hookId: string,
  store: AppStore,
  backupDir?: string,
): string | undefined {
  const hooks = readHooks(settingsPath, store).filter((hook) => hook.id !== hookId);
  return writeHooks(settingsPath, hooks, backupDir);
}

/**
 * Достаёт путь к скрипту из команды вида `node "C:/.../hook.mjs"`.
 * Нужен, чтобы показать, существует ли файл, и дать открыть его на редактирование.
 */
function extractScriptPath(command: string): string | undefined {
  const quoted = /["']([^"']+\.(?:mjs|cjs|js|ts|sh|ps1|py))["']/.exec(command);
  if (quoted?.[1]) return quoted[1];

  const bare = /(?:^|\s)((?:[A-Za-z]:)?[^\s"']+\.(?:mjs|cjs|js|ts|sh|ps1|py))/.exec(command);
  return bare?.[1];
}

/** Первые строки комментария в шапке скрипта — краткое описание для списка. */
function readScriptDescription(scriptPath: string): string | undefined {
  if (!existsSync(scriptPath)) return undefined;

  try {
    const head = readFileSync(scriptPath, 'utf8').split(/\r?\n/).slice(0, 10);
    const comments: string[] = [];

    for (const line of head) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
        comments.push(trimmed.replace(/^(\/\/|#)\s?/, ''));
        continue;
      }
      if (comments.length > 0) break;
    }

    return comments.join(' ').trim() || undefined;
  } catch {
    return undefined;
  }
}
