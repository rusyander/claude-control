import { readCoreConfig, sectionProblem } from '../../platform/core-config/read.ts';
import type { PollEnabled } from './poller.ts';

/**
 * Включение опроса форжа (05:77, G2) — только человеком, только в конфиге ядра:
 * `config.json` → `forgePoll: ["<путь исходного репозитория>", …]`. Никогда из файлов репозитория
 * и не инструментом модели. Читается единым читателем настройки на каждом круге опроса: правка
 * через API действует со следующего круга, правка мимо API (дрейф, G6) — не действует. Файла или
 * ключа нет — выключен; не читается или раздел не прошёл схему — тоже выключен (лишний опрос не
 * начинается), причина названа.
 */

export function forgePollOf(configPath: string): PollEnabled {
  const read = readCoreConfig({ config: configPath });
  if ('absent' in read) return { repos: [] };
  if ('unknown' in read) return { repos: [], problem: `core config unreadable: ${read.unknown}` };
  const problem = sectionProblem(read.value, 'forgePoll');
  if (problem) return { repos: [], problem };
  return { repos: read.value.doc.forgePoll ?? [] };
}
