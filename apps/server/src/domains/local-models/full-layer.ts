import { LOCAL_PLATFORM_ID } from '@agentdeck/contracts/local-models';
import type { OurRules } from '@agentdeck/contracts/platform';
import { defaultOurRules } from '@agentdeck/contracts/platform';
import type { AppStore } from '../../lib/app-store/app-store.ts';
import { readPanelJson, writePanelJson } from '../../lib/app-store/group-sources.ts';
import { readPlatforms, writePlatform } from '../platform/store/store.ts';
import { localLeanRules } from './connect.ts';

/**
 * Перевод локального контура на полный набор — один раз на каталог данных (L6, 15.10).
 *
 * До 15.10 «Подключить» заводило контур с облегчённым набором (без MCP, инструменты
 * белым списком), и человек его не выбирал — его выбрала панель. Владелец: локальная
 * модель должна идти со всем, что есть у облачного Claude. Поэтому запись, чьи слои
 * В ТОЧНОСТИ равны облегчённому набору, получает полный; любая другая — выбор
 * человека, и её не трогаем.
 *
 * Один раз, по отметке: после перевода облегчённый набор можно выбрать на карточке
 * контура осознанно, и следующий старт панели не имеет права вернуть полный.
 */

/** Отметка в каталоге данных панели: перевод уже сделан (или переводить было нечего). */
export const FULL_LAYER_MARKER = 'local-full-layer.json';

export type FullLayerOutcome = 'migrated' | 'kept' | 'absent' | 'done';

interface PlatformLike {
  id: string;
  rules: { ours: OurRules };
}

export interface FullLayerDeps<P extends PlatformLike> {
  read: () => P[];
  write: (platform: P) => void;
  done: () => boolean;
  markDone: (outcome: Exclude<FullLayerOutcome, 'done'>) => void;
}

/** Сверка по каждому выключателю, включая общий и инструменты. */
function sameRules(left: OurRules, right: OurRules): boolean {
  return (Object.keys(right) as (keyof OurRules)[]).every((key) => left[key] === right[key]);
}

export function migrateLocalFullLayer<P extends PlatformLike>(
  deps: FullLayerDeps<P>,
): FullLayerOutcome {
  if (deps.done()) return 'done';
  const local = deps.read().find((platform) => platform.id === LOCAL_PLATFORM_ID);
  if (!local) {
    deps.markDone('absent');
    return 'absent';
  }
  if (!sameRules(local.rules.ours, localLeanRules())) {
    deps.markDone('kept');
    return 'kept';
  }
  deps.write({ ...local, rules: { ...local.rules, ours: defaultOurRules() } });
  deps.markDone('migrated');
  return 'migrated';
}

/**
 * Перевод на хранилище панели: контуры — из настроек, отметка — файлом в каталоге
 * данных. У каждого каталога конфигурации свои настройки, поэтому и отметка своя.
 */
export function runLocalFullLayer(
  store: AppStore,
  appData: string,
  log: (outcome: FullLayerOutcome) => void,
): FullLayerOutcome {
  const outcome = migrateLocalFullLayer({
    read: () => readPlatforms(store),
    write: (platform) => writePlatform(store, platform),
    done: () =>
      readPanelJson<{ outcome?: string } | null>(appData, FULL_LAYER_MARKER, null) !== null,
    markDone: (result) =>
      writePanelJson(appData, FULL_LAYER_MARKER, { outcome: result, at: new Date().toISOString() }),
  });
  log(outcome);
  return outcome;
}
