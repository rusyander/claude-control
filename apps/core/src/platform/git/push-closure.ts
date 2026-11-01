import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { readHooksDirFp, writeHooksDir } from '../hooks-dir.ts';
import { currentOs, type OsKind } from '../os-kind.ts';
import { commonDir } from './common-dir.ts';
import type { GitOptions } from './git.types.ts';
import {
  configMatching,
  configSet,
  configValues,
  remotesOfCopy,
  type ConfigScope,
} from './worktree-config.ts';

/**
 * Закрытие пуша копии единицы на диске (05 §Push closure, G6). Что писать, решает
 * `publisher/closure` (адрес-заглушка, тексты хуков); здесь — только git и файлы.
 *
 * - `extensions.worktreeConfig=true` в общем конфиге — ЕДИНСТВЕННАЯ запись в конфиг человека,
 *   один раз, не снимается. `core.bare=true` или `core.worktree` в общем конфиге — отказ с именем:
 *   с расширением git применил бы их ко всем копиям, а переносить их ядро не вправе.
 * - Покопийно: `remote.<r>.pushurl` = заглушка для каждого удалённого, `core.hooksPath` = каталог
 *   хуков ядра этой копии.
 */

export interface ClosureInput {
  copyDir: string;
  hooksDir: string;
  closedUrl: string;
  scripts: Readonly<Record<string, string>>;
}

/**
 * Состояние закрытия как его видит git копии — запись `publish.closure` и вход сверки дрейфа.
 * `pushurls` — ВСЕ действующие значения `remote.<r>.pushurl` по слоям через `\n`: многозначный
 * ключ, добавленный в общий конфиг, открыл бы push мимо заглушки.
 */
export interface ClosureState {
  copyDir: string;
  pushurls: Record<string, string>;
  /** Покопийный `core.hooksPath`; `''` — снят. */
  hooksPath: string;
  hooksDirFp: string;
  /** Действующие `alias.*` всех слоев (имя без `alias.` → последнее значение). */
  commonAliases: Record<string, string>;
  /** Значения `url.<base>.insteadOf` / `pushInsteadOf` — переписывание адреса заглушки. */
  rewrites: string[];
}

export type ClosureApplied =
  | { applied: ClosureState; enabledWorktreeConfig: boolean }
  | { refused: string }
  | { unknown: string };

/** В конфиге git на Windows путь — с прямыми косыми: обратная там — экранирование. */
const configPath = (path: string, os: OsKind): string =>
  os === 'win32' ? path.split('\\').join('/') : path;

const valueOf = <T>(fact: Fact<T>, what: string): T => {
  if ('value' in fact) return fact.value;
  throw new Error(`${what}: ${'unknown' in fact ? fact.unknown : 'absent'}`);
};

/** Прочитать состояние закрытия копии (каждый слой — свой факт; любой сбой — `unknown`). */
export async function readClosureState(
  copyDir: string,
  hooksDir: string,
  options: GitOptions = {},
): Promise<Fact<ClosureState>> {
  try {
    const remotes = valueOf(await remotesOfCopy(copyDir, options), 'git remote');
    const pushurls = valueOf(
      await configMatching(copyDir, '^remote\\..*\\.pushurl$', 'effective', options),
      'pushurl',
    );
    const hooksPath = valueOf(
      await configValues(copyDir, 'core.hooksPath', 'worktree', options),
      'core.hooksPath',
    );
    const aliases = valueOf(
      await configMatching(copyDir, '^alias\\.', 'effective', options),
      'alias',
    );
    const rewrites = valueOf(
      await configMatching(copyDir, '^url\\..*\\.(push)?insteadof$', 'effective', options),
      'insteadOf',
    );
    const fp = await readHooksDirFp(hooksDir);
    // Нет каталога — пустой отпечаток (дрейф виден сверкой); не прочитан — весь факт `unknown`.
    if ('unknown' in fp) throw new Error(`hooks dir: ${fp.unknown}`);
    return {
      value: {
        copyDir,
        pushurls: Object.fromEntries(
          remotes.map((r) => [
            r,
            // git печатает подраздел (имя удалённого) как есть, раздел и ключ — строчными.
            (pushurls[`remote.${r}.pushurl`] ?? []).join('\n'),
          ]),
        ),
        hooksPath: hooksPath.at(-1) ?? '',
        hooksDirFp: 'value' in fp ? fp.value : '',
        commonAliases: Object.fromEntries(
          Object.entries(aliases).map(([key, values]) => [
            key.slice('alias.'.length),
            values.at(-1) ?? '',
          ]),
        ),
        rewrites: Object.values(rewrites).flat(),
      },
    };
  } catch (error) {
    return { unknown: error instanceof Error ? error.message : String(error) };
  }
}

/** Закрыть копию; повтор на закрытой копии ничего не меняет (те же значения, тот же отпечаток). */
export async function applyPushClosure(
  input: ClosureInput,
  options: GitOptions & { os?: OsKind } = {},
): Promise<ClosureApplied> {
  const os = options.os ?? currentOs();
  try {
    const common = valueOf(await commonDir(input.copyDir, options), 'git common dir');
    const file = { file: join(common, 'config') };
    const bare = valueOf(
      await configValues(input.copyDir, 'core.bare', file, options),
      'core.bare',
    );
    if (bare.at(-1) === 'true')
      return {
        refused: `core.bare=true in ${file.file}: worktree config would apply it to every copy`,
      };
    const worktree = valueOf(
      await configValues(input.copyDir, 'core.worktree', file, options),
      'core.worktree',
    );
    if (worktree.length > 0)
      return {
        refused: `core.worktree is set in ${file.file}: worktree config would apply it to every copy`,
      };
    const ext = valueOf(
      await configValues(input.copyDir, 'extensions.worktreeConfig', file, options),
      'extensions.worktreeConfig',
    );
    const enable = ext.at(-1) !== 'true';
    if (enable) await configSet(input.copyDir, 'extensions.worktreeConfig', 'true', file, options);
    const remotes = valueOf(await remotesOfCopy(input.copyDir, options), 'git remote');
    for (const remote of remotes)
      await configSet(
        input.copyDir,
        `remote.${remote}.pushurl`,
        input.closedUrl,
        'worktree',
        options,
      );
    writeHooksDir(input.hooksDir, input.scripts, os);
    await configSet(
      input.copyDir,
      'core.hooksPath',
      configPath(input.hooksDir, os),
      'worktree',
      options,
    );
    const state = await readClosureState(input.copyDir, input.hooksDir, options);
    if (!('value' in state)) return { unknown: valueOrWhy(state) };
    return { applied: state.value, enabledWorktreeConfig: enable };
  } catch (error) {
    return { unknown: error instanceof Error ? error.message : String(error) };
  }
}

function valueOrWhy(fact: Fact<unknown>): string {
  return 'unknown' in fact ? fact.unknown : 'absent';
}

/**
 * Каталог хуков репозитория для push публикатора — как его нашёл бы git без покопийного слоя:
 * общий конфиг, глобальный, системный, иначе `<common>/hooks` (тот же порядок, что у скриптов
 * хуков ядра). Относительный путь остаётся относительным: git считает его от корня копии.
 */
export async function repoHooksPath(
  copyDir: string,
  options: GitOptions = {},
): Promise<Fact<string>> {
  try {
    const common = valueOf(await commonDir(copyDir, options), 'git common dir');
    const scopes: ConfigScope[] = [{ file: join(common, 'config') }, 'global', 'system'];
    for (const scope of scopes) {
      const values = await configValues(copyDir, 'core.hooksPath', scope, options);
      const found = valueOf(values, 'core.hooksPath').at(-1);
      if (found) return { value: found };
    }
    return { value: join(common, 'hooks') };
  } catch (error) {
    return { unknown: error instanceof Error ? error.message : String(error) };
  }
}
