/**
 * Состояние панели (`state.json`) — фасад над `app-store/`.
 *
 * Класс `AppStore` (`app-store/store.ts`) держит объект состояния и решает,
 * когда файл переписывается; срезы состояния разложены по модулям: загрузка и
 * слияние с дефолтами (`state-file`, `app-store.constants`), отметки выключения
 * (`entities`), снимки выключенных хуков (`disabled-hooks`) и правил
 * (`disabled-rules`), группы и их env
 * (`groups`), реестр проектов (`projects`), цели запуска dev-серверов (`runner`).
 */

export { AppStore } from './store.ts';
export type {
  AppState,
  DisabledRuleSnapshot,
  PermissionFilePlaces,
  PermissionPatternPlace,
  RunnerPrefs,
  RunnerTargetMeta,
} from './app-store.types.ts';
