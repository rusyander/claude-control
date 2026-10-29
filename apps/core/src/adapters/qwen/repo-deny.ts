import type { SessionSpec } from '../adapter.types.ts';
import {
  coreServers,
  readRepoDeny,
  repoDenyRoots,
  repoDenySources,
  type RepoDeny,
} from '../sdk-stream/repo-deny.ts';

/**
 * Запреты репозитория для Qwen Code (F-86). CLI сам читает только `.qwen/settings.json` копии
 * (что из него допускается — `repo-layer.ts`); ядро берёт из файлов источника и копии списки
 * запретов — `permissions.deny` и `tools.exclude` (0.24.3 сливает его в тот же список запретов) —
 * и кладёт их в системные настройки сеанса: запрет источника не теряется, даже если копия его не
 * несёт. Файл — JSONC, как его читает CLI. Своего `settings.local.json` у Qwen нет. Правило пути
 * `/x` CLI считает от корня проекта (cwd копии) — оно идёт как есть.
 */

const PROJECT_DIR = '.qwen';
const FILES = ['settings.json'] as const;
const DENY_FIELDS = [
  ['permissions', 'deny'],
  ['tools', 'exclude'],
] as const;

export function qwenRepoDeny(spec: SessionSpec): RepoDeny {
  return readRepoDeny(
    repoDenySources(repoDenyRoots(spec), PROJECT_DIR, FILES, DENY_FIELDS, true),
    coreServers(spec),
  );
}
