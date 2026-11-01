import type { Profile } from '@agentdeck/contracts/core/records';
import { join } from 'node:path';
import { fileExists, readCopyText } from '../../platform/copy-fs.ts';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';
import { profileSchema } from '../../verifier/profile/schema.ts';

/**
 * Закреплённый профиль задачи (G21, 04:102-103): `task.created.profilePins` держит отпечаток входов
 * профиля на старте, а сам профиль с этим отпечатком — снимок `<profiles>/pinned/<fp>.json`, его
 * кладёт первый старт единицы, пока профиль копии ещё совпадает с пином. Реестр проверок задачи
 * читается из снимка: человек поправил `package.json` посреди задачи — сдвиг назван сигналом и в
 * брифе, а набор проверок задачи остаётся тем, с которым она стартовала. Снимок по отпечатку, не
 * по задаче: у задач с одним пином он общий и не меняется (тот же отпечаток — те же входы).
 */

export function pinnedProfilePath(profilesDir: string, inputsFp: string): string {
  return join(profilesDir, 'pinned', `${inputsFp}.json`);
}

/** Снимок закреплённого профиля; нет или не читается (схема, обрыв записи) — `undefined`. */
export function readPinnedProfile(profilesDir: string, inputsFp: string): Profile | undefined {
  const text = readCopyText(pinnedProfilePath(profilesDir, inputsFp));
  if (text === undefined) return undefined;
  try {
    const parsed = profileSchema.parse(JSON.parse(text)) as Profile;
    return parsed.inputsFp === inputsFp ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Положить снимок, если профиль — тот, что закреплён, и снимка ещё нет. Ответ — лежит ли снимок
 * после вызова; запись не легла — `false` (реестр останется живым, и это будет видно в брифе).
 */
export function snapshotPinnedProfile(
  profilesDir: string,
  profile: Profile,
  pinFp: string,
): boolean {
  const path = pinnedProfilePath(profilesDir, pinFp);
  if (fileExists(path)) return true;
  if (profile.inputsFp !== pinFp) return false;
  try {
    writeFileAtomic(path, `${JSON.stringify(profile, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
