import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { RETIRED_NOTIFY_EVENTS } from '@agentdeck/contracts/integrations';
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
  const loaded = withoutLegacyGroupWatch(
    withoutRetiredKeys(
      withoutRetiredNotifyEvents(
        withCurrentIntegrations(withCurrentPlatformDrivers(input).state).state,
      ),
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
    },
  };
}

/**
 * Ключи, которые прежние версии писали в `state.json`, а нынешняя не знает:
 * заметки главным чатам деревьев (`chatEscalations`) ушли вместе с маршрутами
 * чата групп (этап 10); проектное правило «Ревью после работы»
 * (`projectReviewAfterWork`) — с тумблером в меню чата (этап 10, G14), ревью ведёт
 * сценарий ядра; правило «Подбирать модель под задачу» (`projectCascade`) — с тем
 * же меню (этап 10, G14): подбор по роду работы шёл только в предложение
 * разделения, а разделение из чата снято; срезы сигналов сторожа групп и чатов
 * (`groupWatchSignals`, `chatWatchSignals`) — с проводкой сторожа панели, у них не
 * осталось писателя (этап 10, G14). Старый файл читается как прежде, ключ
 * снимается при чтении, и первая запись его уже не повторяет.
 */
const RETIRED_STATE_KEYS = [
  'chatEscalations',
  'projectReviewAfterWork',
  'projectCascade',
  'groupWatchSignals',
  'chatWatchSignals',
] as const;

/**
 * Поля настроек, которых нынешняя версия не знает: тумблер «Предлагать разделить
 * задачи по чатам» (`taskSplitInitiative`) снят (этап 10, G14) — у карточки
 * разделения нет кнопок; блоки «Экономия групп разделения» (`groupEconomy`) и
 * «Сторож групп разделения» (`groupWatch`) сняты с карточками (этап 10, G15) —
 * рычаги экономии шагов задачи живут в разделе `economy` настройки ядра, своего
 * сторожа у панели нет. Правила автоподтверждения чата (`autoApproveRules`) и
 * срок, через который карточка прав уходила в D-n (`deferAfterMinutes`), сняты
 * (этап 10, G12): о правах шага судит ядро, карточка в D-n больше не уходит, и
 * ни то ни другое никто не читал. Настройки сливаются с умолчаниями разворотом,
 * и без снятия поле жило бы на диске и в ответе панели вечно.
 */
const RETIRED_SETTINGS_KEYS = [
  'taskSplitInitiative',
  'groupEconomy',
  'groupWatch',
  'autoApproveRules',
  'deferAfterMinutes',
] as const;

function withoutRetiredKeys(input: Partial<AppState>): Partial<AppState> {
  const settings = input.settings as Record<string, unknown> | undefined;
  const staleSettings =
    settings !== undefined && RETIRED_SETTINGS_KEYS.some((key) => Object.hasOwn(settings, key));
  if (!staleSettings && !RETIRED_STATE_KEYS.some((key) => Object.hasOwn(input, key))) return input;
  const copy: Record<string, unknown> = { ...input };
  for (const key of RETIRED_STATE_KEYS) delete copy[key];
  if (staleSettings) {
    const cleaned: Record<string, unknown> = { ...settings };
    for (const key of RETIRED_SETTINGS_KEYS) delete cleaned[key];
    copy.settings = cleaned;
  }
  return copy as Partial<AppState>;
}

/**
 * Снятые события подписки (сигнал сторожа групп, этап 10, G14) уходят из сохранённых
 * списков Telegram и вебхука при чтении: строгая схема настроек отбивала бы каждое
 * сохранение, пока в списке лежит имя, которого она не знает. Прежняя отметка переноса
 * `group-signal-telegram` в `doneMigrations` остаётся как есть — её никто не читает.
 */
function withoutRetiredNotifyEvents(loaded: Partial<AppState>): Partial<AppState> {
  const integrations = loaded.settings?.integrations;
  if (!integrations) return loaded;
  const clean = <T extends { events?: unknown }>(target: T | undefined): T | undefined => {
    if (!target || !Array.isArray(target.events)) return target;
    const events = target.events.filter((event) => !RETIRED_NOTIFY_EVENTS.includes(event));
    return events.length === target.events.length ? target : { ...target, events };
  };
  const telegram = clean(integrations.telegram);
  const webhook = clean(integrations.webhook);
  if (telegram === integrations.telegram && webhook === integrations.webhook) return loaded;
  return {
    ...loaded,
    settings: {
      ...loaded.settings!,
      integrations: {
        ...integrations,
        ...(telegram ? { telegram } : {}),
        ...(webhook ? { webhook } : {}),
      },
    },
  };
}

/**
 * Прежнее место сигналов сторожа — поле `watch` группы в записи разделения.
 * Сигналы сняты (этап 10, G14): поле снимается при чтении, остальная запись
 * группы на месте, и первая запись его уже не повторяет.
 */
function withoutLegacyGroupWatch(loaded: Partial<AppState>): Partial<AppState> {
  const plans = loaded.splitPlans;
  if (!plans || typeof plans !== 'object') return loaded;
  const hasWatch = (group: unknown): boolean =>
    typeof group === 'object' && group !== null && Object.hasOwn(group, 'watch');
  const legacy = Object.entries(plans).filter(
    ([, record]) => Array.isArray(record?.groups) && record.groups.some(hasWatch),
  );
  if (legacy.length === 0) return loaded;
  const splitPlans = { ...plans };
  for (const [parent, record] of legacy) {
    const groups = record.groups.map((group) => {
      if (!hasWatch(group)) return group;
      const { watch: _watch, ...rest } = group as typeof group & { watch?: unknown };
      return rest;
    });
    splitPlans[parent] = { ...record, groups };
  }
  return { ...loaded, splitPlans };
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
