import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { groupEconomyChanges, groupEconomyWithDefaults } from '@agentdeck/contracts/group-economy';
import {
  groupSignalsOf,
  groupWatchChanges,
  groupWatchWithDefaults,
  type GroupWatchRecord,
} from '@agentdeck/contracts/group-watch';
import { migrateLegacyPlatforms } from '@agentdeck/contracts/platform-legacy';
import {
  migrateLegacyIntegrations,
  type LegacyTokenMove,
} from '@agentdeck/contracts/integrations-legacy';
import { clearStoredKey, getStoredKey, setStoredKey } from '../provider-keys/provider-keys.ts';
import { readJsonFile } from '../safe-io/safe-io.ts';
import { DEFAULT_STATE } from './app-store.constants.ts';
import type { AppState } from './app-store.types.ts';

/** Файл состояния панели внутри каталога её данных. */
export function stateFilePath(appDataDir: string): string {
  return join(appDataDir, 'state.json');
}

/**
 * Слить прочитанное с дефолтами — одинаково при загрузке с диска и при импорте
 * чужого снимка: файл может быть неполным или из старой версии, а панель не
 * должна на нём падать.
 *
 * Дефолт клонируем целиком. Иначе при пустом state.json вложенные массивы
 * (groups, automations, disabled.hook и т.д.) остаются ОБЩЕЙ ссылкой с
 * модульным DEFAULT_STATE, и мутации одного стора (setEnabled/saveGroup)
 * протекают в другие экземпляры и в сам дефолт — а экземпляров несколько
 * (песочницы, смена целевого каталога через claudeDirOverride).
 */
export function mergeState(input: Partial<AppState>): AppState {
  const loaded = withWatchSlice(
    withGroupSignalSubscription(
      withCurrentIntegrations(withCurrentPlatformDrivers(input).state).state,
    ),
  );
  const base = structuredClone(DEFAULT_STATE);
  return {
    ...base,
    ...loaded,
    disabled: { ...base.disabled, ...loaded.disabled },
    disabledByGroup: { ...base.disabledByGroup, ...loaded.disabledByGroup },
    disabledHooks: { ...base.disabledHooks, ...loaded.disabledHooks },
    envByGroup: { ...base.envByGroup, ...loaded.envByGroup },
    projects: loaded.projects ?? base.projects,
    runnerCommands: { ...base.runnerCommands, ...loaded.runnerCommands },
    runnerPrefs: { ...base.runnerPrefs, ...loaded.runnerPrefs },
    providerChecks: { ...base.providerChecks, ...loaded.providerChecks },
    mcpHealth: { ...base.mcpHealth, ...loaded.mcpHealth },
    projectCodeViews: { ...base.projectCodeViews, ...loaded.projectCodeViews },
    projectCascade: { ...base.projectCascade, ...loaded.projectCascade },
    chatLinks: { ...base.chatLinks, ...loaded.chatLinks },
    treePause: { ...base.treePause, ...loaded.treePause },
    chatPins: { ...base.chatPins, ...loaded.chatPins },
    splitPlans: { ...base.splitPlans, ...loaded.splitPlans },
    integrationHealth: { ...base.integrationHealth, ...loaded.integrationHealth },
    platformHealth: { ...base.platformHealth, ...loaded.platformHealth },
    platformApplied: { ...base.platformApplied, ...loaded.platformApplied },
    portabilityFidelity: { ...base.portabilityFidelity, ...loaded.portabilityFidelity },
    portabilityTransfers: { ...base.portabilityTransfers, ...loaded.portabilityTransfers },
    platformSpend: { ...base.platformSpend, ...loaded.platformSpend },
    integrationLinks: { ...base.integrationLinks, ...loaded.integrationLinks },
    worktreeMirror: { ...base.worktreeMirror, ...loaded.worktreeMirror },
    testsAutoAccept: { ...base.testsAutoAccept, ...loaded.testsAutoAccept },
    settings: {
      ...base.settings,
      ...loaded.settings,
      // Интеграции сливаем ОТДЕЛЬНО: снимок со старой машины (и любой state.json,
      // записанный до этой партии) не знает о них вовсе, а частичный объект из
      // импорта иначе стёр бы недостающие карточки — и связь «Настройки → пять
      // карточек всегда» перестала бы выполняться.
      integrations: {
        ...base.settings.integrations,
        ...loaded.settings?.integrations,
      },
      // На диске лежат только отличия от умолчаний (`stateOnDisk`) — недостающие
      // рычаги берутся из умолчаний ТЕКУЩЕГО кода, а не пропадают.
      groupEconomy: groupEconomyWithDefaults(loaded.settings?.groupEconomy),
      groupWatch: groupWatchWithDefaults(loaded.settings?.groupWatch),
    },
  };
}

/** Отметка разовой переделки подписки Telegram на сигналы сторожа групп. */
export const GROUP_SIGNAL_TELEGRAM_MIGRATION = 'group-signal-telegram';

/**
 * Сигналы сторожа групп в Telegram прежде включал свой выключатель
 * `groupWatch.telegram` (по умолчанию включён); теперь — событие `groupSignal`
 * в списке событий Telegram (F-37). Сохранённый список событий перекрывает
 * умолчания, а выключатель загрузка отбрасывает — без переноса тот, кто получал
 * сигналы, молча перестал бы их получать. Переносим согласие один раз: блок
 * сторожа на диске есть и выключатель не выключен — `groupSignal` в список
 * Telegram. Вебхук не трогаем: сигналов он прежде не получал, согласия не было.
 * Отметка ставится и когда переносить нечего: иначе снятая потом галочка
 * возвращалась бы на каждом старте — блок без выключателя выглядит так же.
 */
export function withGroupSignalSubscription(loaded: Partial<AppState>): Partial<AppState> {
  const done = Array.isArray(loaded.doneMigrations) ? loaded.doneMigrations : [];
  if (done.includes(GROUP_SIGNAL_TELEGRAM_MIGRATION)) return loaded;
  const marked = { ...loaded, doneMigrations: [...done, GROUP_SIGNAL_TELEGRAM_MIGRATION] };
  const settings = loaded.settings;
  const watch: unknown = settings?.groupWatch;
  if (!settings || typeof watch !== 'object' || watch === null) return marked;
  if ((watch as { telegram?: unknown }).telegram === false) return marked;
  const telegram = settings.integrations?.telegram;
  if (!telegram || !Array.isArray(telegram.events)) return marked;
  if (telegram.events.includes('groupSignal')) return marked;
  return {
    ...marked,
    settings: {
      ...settings,
      integrations: {
        ...settings.integrations,
        telegram: { ...telegram, events: [...telegram.events, 'groupSignal'] },
      },
    },
  };
}

/**
 * Сигналы сторожа из записей разделения (прежнее место, поле `watch` группы) —
 * в свой срез `groupWatchSignals` (F-42). Срез уже знает группу — его и держим:
 * он пишется только сторожем. Повторная загрузка ничего не находит.
 */
export function withWatchSlice(loaded: Partial<AppState>): Partial<AppState> {
  const plans = loaded.splitPlans;
  if (!plans || typeof plans !== 'object') return loaded;
  const legacy = Object.entries(plans).filter(
    ([, record]) =>
      Array.isArray(record?.groups) && record.groups.some((group) => group?.watch !== undefined),
  );
  if (legacy.length === 0) return loaded;
  const slice: Record<string, Record<string, GroupWatchRecord>> = {};
  for (const [parent, groups] of Object.entries(loaded.groupWatchSignals ?? {})) {
    slice[parent] = { ...groups };
  }
  const splitPlans = { ...plans };
  for (const [parent, record] of legacy) {
    const own = { ...slice[parent] };
    const groups = record.groups.map((group) => {
      if (group?.watch === undefined) return group;
      const { watch, ...rest } = group;
      const signals = groupSignalsOf(watch);
      if (signals.length > 0 && !own[String(group.index)]) own[String(group.index)] = { signals };
      return rest;
    });
    if (Object.keys(own).length > 0) slice[parent] = own;
    splitPlans[parent] = { ...record, groups };
  }
  return { ...loaded, splitPlans, groupWatchSignals: slice };
}

/**
 * Состояние в том виде, в каком оно пишется в файл: рычаги экономии групп —
 * только отличные от умолчаний, иначе первое же сохранение заморозило бы все
 * умолчания блока и их смена в коде до пользователя не дошла бы.
 */
export function stateOnDisk(state: AppState): unknown {
  return {
    ...state,
    settings: {
      ...state.settings,
      groupEconomy: groupEconomyChanges(state.settings.groupEconomy),
      groupWatch: groupWatchChanges(state.settings.groupWatch),
    },
  };
}

/**
 * Контуры под прежним именем драйвера — под нынешним (`platform-legacy.ts`).
 * `changed` говорит загрузке, что файл пора переписать: иначе старое имя жило
 * бы на диске вечно и узнавалось бы на каждом старте. Повторный запуск находит
 * нынешнее имя и ничего не пишет.
 */
export function withCurrentPlatformDrivers(loaded: Partial<AppState>): {
  state: Partial<AppState>;
  changed: boolean;
} {
  const { platforms, changed } = migrateLegacyPlatforms(loaded.settings?.platforms);
  if (!changed || !loaded.settings) return { state: loaded, changed: false };
  return {
    state: { ...loaded, settings: { ...loaded.settings, platforms } as AppState['settings'] },
    changed: true,
  };
}

/**
 * Интеграции в прежнем виде — в нынешнем (`integrations-legacy.ts`): связка
 * Atlassian → Jira и Confluence, фордж и тест-менеджмент с выбором вида → своя
 * интеграция на каждую систему. `tokens` — какие ключи переехать за ними
 * (`moveLegacyIntegrationTokens`); снимок с другой машины ключей не несёт, и
 * там переезжает только видимая половина.
 */
export function withCurrentIntegrations(loaded: Partial<AppState>): {
  state: Partial<AppState>;
  tokens: LegacyTokenMove[];
  changed: boolean;
} {
  const migrated = migrateLegacyIntegrations(
    loaded.settings?.integrations,
    loaded.integrationHealth,
  );
  if (!migrated.changed || !loaded.settings) return { state: loaded, tokens: [], changed: false };
  return {
    state: {
      ...loaded,
      integrationHealth: migrated.health as AppState['integrationHealth'],
      settings: {
        ...loaded.settings,
        integrations: migrated.integrations,
      } as AppState['settings'],
    },
    tokens: migrated.tokens,
    changed: true,
  };
}

/**
 * Ключи прежних интеграций — на места нынешних, в том же зашифрованном
 * хранилище. Занятое место не перезаписывается (ключ, введённый уже в новой
 * версии, правдивее старого); прежний ключ стирается после всех переносов —
 * иначе секрет жил бы в файле без карточки, через которую его видно и можно
 * забыть.
 */
export function moveLegacyIntegrationTokens(
  appDataDir: string,
  moves: readonly LegacyTokenMove[],
): void {
  for (const move of moves) {
    const value = getStoredKey(appDataDir, move.from);
    if (!value) continue;
    for (const to of move.to) {
      if (!getStoredKey(appDataDir, to)) setStoredKey(appDataDir, to, value);
    }
  }
  for (const move of moves) {
    if (getStoredKey(appDataDir, move.from)) clearStoredKey(appDataDir, move.from);
  }
}

/**
 * Прочитать state.json, пережив испорченный файл.
 *
 * Разбор бросает на оборванном или изуродованном JSON (выключили питание
 * посреди записи, руками правили файл), а вызывается это на старте сервера —
 * исключение отсюда означало «панель не запускается вовсе, и починить её нечем,
 * потому что интерфейс не поднялся». Поэтому битый файл отодвигаем в сторону
 * под именем `state.corrupt.json` (не удаляем: там группы и сценарии
 * пользователя, их ещё можно вытащить руками) и стартуем с дефолтов.
 */
export function readStateFile(appDataDir: string): Partial<AppState> {
  const stateFile = stateFilePath(appDataDir);
  try {
    return readJsonFile<Partial<AppState>>(stateFile, {});
  } catch (error) {
    const parked = join(appDataDir, 'state.corrupt.json');
    try {
      renameSync(stateFile, parked);
    } catch {
      // Переименовать не вышло (файл занят, нет прав) — это не повод не
      // запуститься: дальше работаем на дефолтах, первая же запись перезапишет.
    }
    process.stderr.write(
      `state.json не читается (${(error as Error).message}); файл отложен в ${parked}, настройки взяты по умолчанию\n`,
    );
    return {};
  }
}
