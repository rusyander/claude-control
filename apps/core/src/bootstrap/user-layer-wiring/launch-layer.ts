import type { UserLayerInventory } from '@agentdeck/contracts/core/user-layer';
import type { CliAdapter } from '../../adapters/adapter.types.ts';
import type { GrantRequiredRow, LaunchLayer, SplitEnv } from '../../conductor/estimate/index.ts';
import type { LayerText } from '../../conductor/lint/launch-lint.ts';
import { readCoreConfig } from '../../platform/core-config/read.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import { readBytesSync } from '../../platform/safe-io/files.ts';

/**
 * Слой человека на экране запуска (07:23-24, 06:108-112): опись CLI запуска над исходным
 * репозиторием, тексты файлов слоя для линта, строки `grantRequired` конфига ядра. Тот же
 * `CliAdapter.inventory`, что пишет `layer.changed` сеанса, — хеш в `task.created` и у сеанса
 * считается одной функцией. Слой репозитория входит: доверие копии решает дорога на старте
 * сеанса, а экран запуска показывает всё, что может дойти до сеанса.
 */

/** Виды источников, чей текст читает линт: инструкции, правила, навыки (настройки — JSON). */
const TEXT_KINDS: ReadonlySet<UserLayerInventory['sources'][number]['kind']> = new Set([
  'instructions',
  'rules',
  'skill',
  'agent',
]);
/** Байт на файл для линта: длинный файл линтуется по началу, хеш описи считан по всему. */
const TEXT_BYTES_MAX = 256 * 1024;

export interface LaunchLayerDeps {
  /** Переходники разрешённого набора запуска в порядке предпочтения. */
  adapters(): readonly CliAdapter[];
  pin(): Record<string, string>;
}

function textsOf(inventory: UserLayerInventory): LayerText[] {
  const texts: LayerText[] = [];
  for (const source of inventory.sources) {
    if (!TEXT_KINDS.has(source.kind)) continue;
    const got = readBytesSync(source.path);
    // Не прочёлся — линт его не видит; опись уже назвала его в `unread`, если он не прочёлся и там.
    if (!('value' in got)) continue;
    texts.push({ path: source.path, text: got.value.subarray(0, TEXT_BYTES_MAX).toString('utf8') });
  }
  return texts;
}

export function launchLayerPort(deps: LaunchLayerDeps): NonNullable<SplitEnv['userLayer']> {
  return async (repos) => {
    const asked = { hooks: 'on', skills: 'on' } as const;
    const adapter = deps.adapters().find((a) => a.inventory);
    const repo = repos[0];
    if (!adapter?.inventory || !repo) {
      const why = repo
        ? 'no CLI of the launch set reads its user layer'
        : 'the task names no repository';
      return { inventory: null, texts: [], asked, ran: asked, detail: [why] } satisfies LaunchLayer;
    }
    const inventory = adapter.inventory(deps.pin(), repo.path, true);
    const detail = [
      `${adapter.id} layer over ${repo.repoKey}; the copy's trust is decided at session start`,
    ];
    if (repos.length > 1) detail.push(`other repositories' project layers are read per unit`);
    return { inventory, texts: textsOf(inventory), asked, ran: asked, detail };
  };
}

/** Строки `grantRequired` конфига ядра; настройки нет или раздел не прочёлся — строк нет. */
export function grantRequiredPort(
  layout: Pick<CoreHomeLayout, 'config'>,
): NonNullable<SplitEnv['grantRequired']> {
  return (): readonly GrantRequiredRow[] => {
    const read = readCoreConfig(layout);
    return 'value' in read ? (read.value.doc.grantRequired ?? []) : [];
  };
}
