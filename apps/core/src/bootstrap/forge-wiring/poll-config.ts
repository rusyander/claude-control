import { pathKey } from '../../platform/paths.ts';
import { readCoreConfig, sectionProblem } from '../../platform/core-config/read.ts';
import type { PollEnabled } from './poller.ts';

/**
 * Включение опроса форжа (05:77, G2) — только человеком, только в конфиге ядра:
 * `config.json` → `forgePoll: ["<путь исходного репозитория>", …]`. Никогда из файлов репозитория
 * и не инструментом модели. Читается единым читателем настройки на каждом круге опроса: правка
 * через API действует со следующего круга, правка мимо API (дрейф, G6) — не действует. Файла или
 * ключа нет — выключен; не читается или раздел не прошёл схему — тоже выключен (лишний опрос не
 * начинается), причина названа.
 *
 * Этап 12 (P157): к настроенным добавляются репозитории MR с остановкой «до конца» (`stopRepos`)
 * — человек решил смотреть этот MR ходом на доске, а не строкой конфига. Какие MR в них смотреть,
 * решает `watched` (остальные MR такого репозитория — как настроен он сам).
 */

function configured(configPath: string): PollEnabled {
  const read = readCoreConfig({ config: configPath });
  if ('absent' in read) return { repos: [] };
  if ('unknown' in read) return { repos: [], problem: `core config unreadable: ${read.unknown}` };
  const problem = sectionProblem(read.value, 'forgePoll');
  if (problem) return { repos: [], problem };
  return { repos: read.value.doc.forgePoll ?? [] };
}

export function forgePollOf(configPath: string, stopRepos?: () => readonly string[]): PollEnabled {
  const base = configured(configPath);
  const extra = stopRepos?.() ?? [];
  if (extra.length === 0) return base;
  const keys = new Set(base.repos.map((r) => pathKey(r)));
  const added = extra.filter((r) => !keys.has(pathKey(r)));
  return { ...base, repos: [...base.repos, ...added] };
}

/** Ключи путей настроенных репозиториев — для MR без остановки с доски (`watched`). */
export function forgePollKeys(configPath: string): ReadonlySet<string> {
  return new Set(configured(configPath).repos.map((r) => pathKey(r)));
}
