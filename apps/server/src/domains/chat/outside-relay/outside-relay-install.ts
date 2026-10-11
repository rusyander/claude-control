import { fileURLToPath } from 'node:url';
import type { Hook, HookEvent } from '@agentdeck/contracts';
import type { AppStore } from '../../../lib/app-store/app-store.ts';
import { readHooks, writeHooks } from '../../hooks/hooks.ts';

/**
 * Хуки пересылки в настройках Claude Code человека: какие нужны, стоят ли они
 * и как их вписать или снять. Запись идёт тем же писателем, что раздел
 * «Хуки», с резервной копией в «Истории». Хук, выключенный человеком в
 * «Хуках», обратно не включается: выключение — его решение.
 */

/** По имени файла хук узнаётся в настройках: команда несёт путь к нему. */
export const RELAY_HOOK_FILE = 'outside-relay-hook.mjs';
const HOOK_PATH = fileURLToPath(new URL(`./${RELAY_HOOK_FILE}`, import.meta.url));

/**
 * Хук прав ждёт телефона до 50 минут; CLI снимает хук по его таймауту, и
 * запрос пропадает с телефона раньше, чем человек до него дойдёт. Порог
 * «короткого» таймаута — 10 минут: меньше на ответ с телефона не рассчитываем.
 * Без таймаута у CLI — 60 с.
 */
const MIN_PERMISSION_TIMEOUT_S = 600;

interface RelayHookSpec {
  event: HookEvent;
  matcher?: string;
  timeout: number;
}

/**
 * `PermissionRequest` — вопросы и права (ждёт человека); `PostToolUse` и
 * `Stop` — сообщения посреди хода. Эти два стоят на каждом шаге каждой
 * сессии, поэтому таймаут короткий: панель молчит — шаг не ждёт.
 *
 * Те же события и таймауты человек читает в подсказках (`relayMissing`,
 * `relayShortTimeout` телефона, `hookShortTimeout` панели, справка `phone`) и
 * их вписывает `tools/qa/check-outside-relay.mjs` — правка здесь идёт туда же.
 */
const RELAY_HOOKS: readonly RelayHookSpec[] = [
  { event: 'PermissionRequest', matcher: '*', timeout: 3600 },
  { event: 'PostToolUse', matcher: '*', timeout: 10 },
  { event: 'Stop', timeout: 10 },
];

export function relayHookCommand(url: string, tokenFile: string): string {
  return `node "${HOOK_PATH}" --url ${url} --token-file "${tokenFile}"`;
}

const isRelay = (hook: Hook): boolean => hook.command.includes(RELAY_HOOK_FILE);

const same = (hook: Hook, spec: RelayHookSpec, command: string): boolean =>
  hook.isEnabled &&
  hook.command === command &&
  (hook.matcher ?? undefined) === spec.matcher &&
  hook.timeout === spec.timeout;

export interface RelayHooksStatus {
  /** Все три хука стоят и включены. */
  installed: boolean;
  /** Хук прав стоит с таймаутом короче ожидания телефона. */
  shortTimeout: boolean;
}

export function relayHooksStatus(settingsPath: string, store: AppStore): RelayHooksStatus {
  const ours = readHooks(settingsPath, store).filter((hook) => isRelay(hook) && hook.isEnabled);
  const permission = ours.filter((hook) => hook.event === 'PermissionRequest');
  return {
    installed: RELAY_HOOKS.every((spec) => ours.some((hook) => hook.event === spec.event)),
    shortTimeout:
      permission.length > 0 &&
      permission.every((hook) => (hook.timeout ?? 60) < MIN_PERMISSION_TIMEOUT_S),
  };
}

/**
 * Привести хуки пересылки к нужному виду: недостающие добавить, устаревшие
 * (другой адрес панели, путь к скрипту, прежний `PreToolUse` для вопросов)
 * заменить. Ничего не изменилось — файл не трогается. `true` — записано.
 */
export function installRelayHooks(
  settingsPath: string,
  store: AppStore,
  command: string,
  backupDir?: string,
): boolean {
  const hooks = readHooks(settingsPath, store);
  const ours = hooks.filter(isRelay);
  const next = hooks.filter((hook) => !isRelay(hook));
  let changed = false;
  for (const spec of RELAY_HOOKS) {
    const existing = ours.filter((hook) => hook.event === spec.event);
    if (existing.some((hook) => !hook.isEnabled)) {
      next.push(...existing);
      continue;
    }
    const kept = existing.length === 1 ? existing[0] : undefined;
    if (kept && same(kept, spec, command)) {
      next.push(kept);
      continue;
    }
    changed = true;
    next.push({
      id: `${spec.event}:new:${Date.now()}`,
      event: spec.event,
      ...(spec.matcher ? { matcher: spec.matcher } : {}),
      command,
      timeout: spec.timeout,
      isEnabled: true,
      scriptPath: HOOK_PATH,
      groupIds: [],
      source: 'settings',
    });
  }
  // Хук пересылки на событии, которого в наборе нет (прежний PreToolUse для
  // вопросов), отвечал бы дважды — уходит.
  if (ours.some((hook) => !RELAY_HOOKS.some((spec) => spec.event === hook.event))) changed = true;
  if (!changed) return false;
  writeHooks(settingsPath, next, backupDir, 'settings');
  return true;
}

/** Снять хуки пересылки: выключили пересылку — в чужих сессиях не остаётся ничего. */
export function uninstallRelayHooks(
  settingsPath: string,
  store: AppStore,
  backupDir?: string,
): boolean {
  const hooks = readHooks(settingsPath, store);
  const ours = hooks.filter(isRelay);
  if (ours.length === 0) return false;
  store.pruneDisabledHooks(ours.filter((hook) => !hook.isEnabled).map((hook) => hook.id));
  writeHooks(
    settingsPath,
    hooks.filter((hook) => !isRelay(hook)),
    backupDir,
    'settings',
  );
  return true;
}
