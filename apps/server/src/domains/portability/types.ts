import type {
  EnvItem,
  EnvNeed,
  EnvScope,
  EnvSectionState,
  EnvSkip,
} from '@agentdeck/contracts/portable-env';
import type { ConfigProvider } from '../../providers/types.ts';

/**
 * Договор импорта: что импортёру дают и что он возвращает.
 *
 * Импортёр НИЧЕГО не знает об эмиттерах — общего у половин ровно два, канон и
 * каталог возможностей (§5.3 плана). Поэтому здесь нет ни цели переноса, ни
 * пары «источник → приёмник».
 */

/**
 * Состояние панели, без которого «включено/выключено» соврало бы: выключенный
 * скилл лежит в `skills/.disabled/`, а выключенное правило — в служебном разделе
 * файла, но отметка может стоять и в состоянии панели.
 *
 * Интерфейс УЗКИЙ намеренно: импортёр обязан работать и на чужом доме (проверка
 * `check-portability-import.mjs` разворачивает эталонный дом во временном
 * каталоге, где никакого состояния панели нет). Состояния нет → всё включено,
 * ровно как `readHooksFromFiles` читает файлы проекта.
 */
export interface ImportState {
  isDisabled(kind: string, id: string, legacyId?: string): boolean;
}

/**
 * Замеренные требования скриптов: путь скрипта → факты, которые он ДЕЙСТВИТЕЛЬНО
 * прочитал на живом прогоне (`needs-probe.ts`). Статический разбор — гипотеза,
 * и признать её достаточной нельзя (П0.2); наблюдение приезжает сюда и
 * побеждает гипотезу.
 */
export type ObservedNeeds = ReadonlyMap<string, readonly EnvNeed[]>;

/** Что нужно импортёру, чтобы собрать канон одного провайдера на одном уровне. */
export interface ImportDeps {
  provider: ConfigProvider;
  scope: EnvScope;
  /** Пользовательский каталог конфигурации; уважает его только Claude. */
  override?: string;
  /**
   * Корень проекта — обязателен при `scope: 'project'` и не значит ничего при
   * глобальном (П2.5). Уровень выбирает ПУТИ, а не набор читателей: разделы у
   * обоих уровней те же самые, и считает их одна функция `sectionTargets`.
   */
  projectRoot?: string;
  state?: ImportState;
  observedNeeds?: ObservedNeeds;
}

/**
 * Результат одного импортёра: записи и названные пропуски. Раздела нет — это
 * ПРОПУСК С ПРИЧИНОЙ, а не исключение: у провайдера без хуков хуков нет
 * законно, и падать на этом было бы ложью о поломке.
 */
export interface ImportResult {
  items: EnvItem[];
  skipped: EnvSkip[];
  /**
   * Рубильники разделов источника (П2.6): раздел, выключенный целиком, не
   * пропуск — его записи существуют, но не действуют, и канон везёт их
   * выключенными. Список необязателен ровно потому, что у большинства этапов
   * рубильника нет вовсе, а пустой массив на каждом обходе — шум.
   */
  sectionStates?: EnvSectionState[];
}

export type Importer = (deps: ImportDeps) => ImportResult;

/** Импортёра для этого id в каталоге нет — одиннадцатый CLI без своего файла (§5.4). */
export class UnknownImportProviderError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`Импортёр среды для провайдера «${providerId}» не заведён.`);
    this.name = 'UnknownImportProviderError';
    this.providerId = providerId;
  }
}
