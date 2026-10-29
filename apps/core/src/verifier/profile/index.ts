import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { CheckRegistry, Profile } from '@agentdeck/contracts/core/records';
import { absent, readFact, type ReadOptions } from '../../lib/facts/read-fact.ts';
import { currentOs, type OsKind } from '../../platform/os-kind.ts';
import { readRepoView, realRepoViewIo } from '../../platform/repo-view.ts';
import type { RepoView, RepoViewIo } from '../../platform/repo-view.types.ts';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';
import { readTextFact } from '../../platform/safe-io/files.ts';
import { detectProfile, inputsFingerprint } from './detect.ts';
import { PROFILE_VIEW_SPEC } from './inputs.ts';
import { profileSchema } from './schema.ts';

export { detectProfile, inputsFingerprint, DETECT_VERSION } from './detect.ts';
export { applyProjectFile, PROJECT_FILE } from './project-file.ts';

/**
 * `profileOf(repo)` / `registryOf(repo)` (04:45-52, 04:102-103) — вход зон A, C, F и
 * предполётной проверки. Профиль живёт в доме ядра (`profiles/<hash repoKey>.json`), в репозиторий
 * не пишется никогда. Отпечаток входов не сдвинулся — сохранённый профиль как есть (правки человека
 * в нём); сдвинулся — обнаружение заново, правки человека переносятся. Сбой чтения репозитория —
 * `unknown`, никогда угаданный или пустой профиль (P44): реестр `unknown` → отказ
 * `registry-unreadable` по классу `check.registry` (`onUnknown: refuse`, fix-w2R-X01).
 */

export interface RepoRef {
  repoKey: string;
  path: string;
}

export interface ProfileDeps {
  profilesDir: string;
  os?: OsKind;
  now?: () => number;
  /** Подмены — только для тестов отказов (P44). */
  viewIo?: RepoViewIo;
  readStored?: (path: string) => Promise<Fact<string>>;
  write?: (path: string, text: string) => void;
  viewOptions?: ReadOptions<RepoView>;
  readOptions?: ReadOptions<unknown>;
}

export function profilePath(profilesDir: string, repoKey: string): string {
  return join(
    profilesDir,
    `${createHash('sha256').update(repoKey).digest('hex').slice(0, 32)}.json`,
  );
}

type Stored = { value: Profile } | { absent: true } | { unknown: string };

async function readStored(path: string, deps: ProfileDeps): Promise<Stored> {
  const text = await (deps.readStored ?? readTextFact)(path);
  if (!('value' in text)) return text;
  const parsed = await readFact(
    'profile.read',
    () => profileSchema.parse(JSON.parse(text.value)) as Profile,
    deps.readOptions as ReadOptions<Profile>,
  );
  return parsed;
}

/** Профиль репозитория: сохранённый, если входы не сдвинулись; иначе обнаруженный заново. */
export async function profileOf(repo: RepoRef, deps: ProfileDeps): Promise<Fact<Profile>> {
  const view = await readRepoView(
    repo.path,
    PROFILE_VIEW_SPEC,
    deps.viewIo ?? realRepoViewIo,
    deps.viewOptions,
  );
  if (!('value' in view)) return view;
  const fp = inputsFingerprint(view.value);
  const path = profilePath(deps.profilesDir, repo.repoKey);
  const stored = await readStored(path, deps);
  if ('value' in stored && stored.value.inputsFp === fp && stored.value.repoKey === repo.repoKey)
    return { value: stored.value };
  const detected = detectProfile(view.value, { os: deps.os ?? currentOs() });
  const profile: Profile = {
    v: 1,
    repoKey: repo.repoKey,
    inputsFp: fp,
    ...detected,
    userEdits: 'value' in stored ? stored.value.userEdits : {},
    detectedAt: (deps.now ?? Date.now)(),
  };
  if ('unknown' in stored) {
    // Нечитаемый или чужой файл не затирается: в нём могут быть правки человека.
    profile.notes.push({
      subject: path,
      why: `stored profile unreadable (${stored.unknown}): not overwritten`,
    });
    return { value: profile };
  }
  (deps.write ?? ((p: string, t: string) => writeFileAtomic(p, t)))(
    path,
    `${JSON.stringify(profile, null, 2)}\n`,
  );
  return { value: profile };
}

/** Реестр проверок под классом `check.registry`: профиль `unknown` → реестр `unknown`, не пустой. */
export function registryOf(repo: RepoRef, deps: ProfileDeps): Promise<Fact<CheckRegistry>> {
  return readFact('check.registry', async () => {
    const profile = await profileOf(repo, deps);
    if ('unknown' in profile) throw new Error(profile.unknown);
    if ('absent' in profile) return absent();
    return profile.value.registry;
  });
}

/**
 * Сдвиг профиля посреди задачи (04:102-103): закреплённый в `task.created` отпечаток против
 * нового. Сдвиг журналирует дирижёр и применяет со следующего шага; здесь только факт.
 */
export async function profileMoved(
  pinned: Pick<Profile, 'inputsFp'>,
  repo: RepoRef,
  deps: ProfileDeps,
): Promise<Fact<{ moved: boolean; profile: Profile }>> {
  const fresh = await profileOf(repo, deps);
  if (!('value' in fresh)) return fresh;
  return { value: { moved: fresh.value.inputsFp !== pinned.inputsFp, profile: fresh.value } };
}
