import type { CliAdapter } from '../../adapters/adapter.types.ts';
import type { RoadStart } from './road.types.ts';

/**
 * Коды отказа продолжить разговор, начатый не ядром (этап 10, F2). Закрытый список: экран чата
 * показывает код как есть, а дорога не продолжает разговор ни по одному из них.
 *  - `resume_other_cli` — просьба о разговоре одного CLI, а сессия идёт другим;
 *  - `resume_unproven` — у переходника нет `ownsTranscript`: формат хранилища CLI не доказан;
 *  - `resume_not_owned` — транскрипта этого id нет в хранилище CLI или он другого корня;
 *  - `resume_unreadable` — транскрипт есть, но переходник не смог его прочитать.
 */
export const ADOPT_REFUSALS = [
  'resume_other_cli',
  'resume_unproven',
  'resume_not_owned',
  'resume_unreadable',
] as const;
export type AdoptRefusal = (typeof ADOPT_REFUSALS)[number];

/**
 * Суд просьбы продолжить чужой разговор — до аренды, каталога и процесса. Id от панели — только
 * просьба: продолжение идёт, лишь когда сам переходник CLI сессии подтвердил, что транскрипт этого
 * id лежит в его хранилище для корня сессии (`cwd` — корень чата на месте). Не просьба — `null`.
 */
export function adoptRefusal(start: RoadStart, adapter: CliAdapter): AdoptRefusal | null {
  const resume = start.resume;
  if (!resume?.adopt) return null;
  if (resume.adopt.adapter !== start.adapterId) return 'resume_other_cli';
  if (!adapter.ownsTranscript) return 'resume_unproven';
  const owned = adapter.ownsTranscript(start.pin, start.cwd, resume.conversationId);
  if (owned === true) return null;
  return owned === false ? 'resume_not_owned' : 'resume_unreadable';
}
