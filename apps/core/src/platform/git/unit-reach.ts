import type { Fact } from '@agentdeck/contracts/core/facts';
import { readClass, readFact } from '../../lib/facts/read-fact.ts';
import type { GitOptions } from './git.types.ts';
import { git } from './run.ts';

/**
 * «Этот sha — работа копии?» для стража публикации (05 §Push closure, G7): коммит достижим из
 * HEAD копии или любой записи её reflog (сеанс мог сбросить ветку после пуша), но не из того,
 * что remote уже имел. Один `rev-list` с отсечением базы: история репозитория не обходится
 * целиком. Объект, которого в репозитории нет, — не наш: пушат только то, что есть локально.
 */

/** Сколько последних записей reflog брать: длиннее командная строка Windows не принимает. */
export const REFLOG_TIPS = 200;

const SHA_CHARS = new Set('0123456789abcdef');
const isSha = (s: string): boolean => s.length >= 40 && [...s].every((c) => SHA_CHARS.has(c));

export function unitReach(
  copyDir: string,
  candidates: readonly string[],
  known: readonly string[],
  options: GitOptions = {},
): Promise<Fact<Record<string, boolean>>> {
  const { timeoutMs } = readClass('git.history');
  return readFact('git.history', async () => {
    if (candidates.length === 0) return {};
    const call = { ...options, timeoutMs, acceptNonZero: true };
    const reflog = await git(
      copyDir,
      ['log', '-g', '--format=%H', `-n${REFLOG_TIPS}`, 'HEAD'],
      call,
    );
    // Нет reflog (выключен `core.logAllRefUpdates`) — код 128: остаётся сама HEAD.
    const tips = new Set(reflog.code === 0 ? reflog.stdout.split('\n').filter(isSha) : []);
    tips.add('HEAD');
    const out = await git(
      copyDir,
      ['rev-list', '--ignore-missing', ...tips, '--not', ...known.filter(isSha)],
      { ...options, timeoutMs },
    );
    const ours = new Set(out.stdout.split('\n').filter(isSha));
    return Object.fromEntries(candidates.map((sha) => [sha, ours.has(sha)]));
  });
}
