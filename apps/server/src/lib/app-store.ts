import { join } from 'node:path';
import type {
  AppSettings,
  Automation,
  EntityKind,
  Group,
  Hook,
  Project,
  ProviderCheckResult,
} from '@claude-control/contracts';
import { readJsonFile, writeJsonFile } from './safe-io.ts';

/**
 * Память панели об одной ЦЕЛИ запуска: см. `AppState.runnerPrefs`.
 *
 * Ключ карты — нормализованный абсолютный каталог запуска. У проекта без
 * монорепы это сам корень, поэтому записи, сделанные до появления подпапок,
 * читаются как есть: `projectPath`/`dir` у них пусты и означают «корень».
 */
export interface RunnerPrefs {
  /** Абсолютный каталог запуска (ключ карты — его нормализованный вид). */
  path: string;
  /** Корень проекта. Пусто у старых записей — тогда это сам `path`. */
  projectPath?: string;
  /** Подпапка относительно корня; пусто — сам корень. */
  dir?: string;
  /** Поднимать dev-сервер при старте сервера панели. */
  autostart?: boolean;
  /** Порт прошлого удачного запуска — подсказка в интерфейсе. */
  port?: number;
  /** Порт, закреплённый пользователем: уходит в `PORT` и ожидается именно он. */
  pinnedPort?: number;
  /** Оверрайд команды запуска. */
  command?: string;
}

/** Чем цель отличается от голого пути: корень проекта и подпапка внутри него. */
export interface RunnerTargetMeta {
  projectPath?: string;
  dir?: string;
}

/**
 * Данные, которых нет в конфигах Claude Code: группы, сценарии, отметки
 * «выключено» и настройки самого приложения. Живут отдельным файлом внутри
 * claude-control/, чтобы не засорять конфиги тем, чего Claude Code не понимает.
 *
 * Выключение сущности хранится здесь, а не удалением из конфига: так текст
 * правила или команда хука не теряются и их можно вернуть одним переключателем.
 */
export interface AppState {
  groups: Group[];
  automations: Automation[];
  disabled: Record<EntityKind, string[]>;
  /**
   * Кто погашен группой: вид → id сущности → список групп, которые её гасят.
   *
   * Отдельно от `disabled` намеренно. Иначе включение группы «воскрешало» бы
   * то, что человек выключил вручную по отдельности, а сущность из двух групп
   * включалась бы первой же из них. Здесь сущность оживает, только когда её
   * отпустили все группы и она не выключена вручную.
   */
  disabledByGroup: Record<EntityKind, Record<string, string[]>>;
  /**
   * Команды выключенных хуков.
   *
   * Хук выключается удалением из settings.json — иначе Claude Code продолжал
   * бы его исполнять. Но тогда его текст в файле не остаётся, и вернуть его
   * было бы нечем: выключение оказалось бы удалением. Поэтому снимок хука
   * хранится здесь, пока он выключен, и подмешивается обратно в список.
   */
  disabledHooks: Record<string, Hook>;
  /**
   * Какие переменные окружения применила каждая группа: id группы → имена
   * ключей, записанных ею в settings.json. По этой отметке при выключении
   * снимаются только свои ключи (не задев ручные и чужие), а при пересечении
   * групп ключ остаётся, пока его держит хотя бы одна.
   */
  envByGroup: Record<string, string[]>;
  /**
   * Реестр проектов уровня конфигурации: запомненные пути к каталогам проектов,
   * чьи `CLAUDE.md`, `.claude/settings.json` и `.mcp.json` панель показывает и
   * правит. Хранится здесь, а не в конфигах Claude Code: это данные самой панели,
   * а сами файлы проекта остаются в его каталоге и не дублируются.
   */
  projects: Project[];
  /**
   * Оверрайд команды запуска dev-сервера на проект: нормализованный путь →
   * командная строка. Пусто/нет ключа — команда определяется автоматически по
   * package.json проекта (скрипт dev/start и пакетный менеджер по lock-файлу).
   */
  runnerCommands: Record<string, string>;
  /**
   * Что панель помнит о dev-сервере проекта между запусками: нормализованный
   * путь → {исходный путь, автозапуск, порт прошлого запуска}.
   *
   * Исходный путь хранится вместе с ключом намеренно: ключ нормализован (на
   * Windows ещё и в нижнем регистре), а запускать процесс надо в каталоге,
   * который написал пользователь. Порт помнится и без автозапуска — тогда
   * адрес проекта не скачет от запуска к запуску.
   */
  runnerPrefs: Record<string, RunnerPrefs>;
  settings: AppSettings;
  /**
   * Итоги проверки провайдеров: id провайдера → последний результат.
   *
   * Хранится здесь, а не в настройках: это не выбор пользователя, а факт о его
   * машине («здесь круг чтения-записи сошёлся, ассистент ответил»). Из него
   * берётся бейдж «проверен» вместо вечного «экспериментальный».
   */
  providerChecks: Record<string, ProviderCheckResult>;
  /**
   * Verifier парольной фразы шифрования копий секретов. Не сама фраза, а её
   * производная (scrypt-хэш с солью): по нему проверяется, та ли фраза введена,
   * восстановить фразу по нему нельзя. Пусто — шифрование ещё не настраивали.
   * Хранится тут, а не в settings: это не пользовательская настройка, а
   * технический артефакт, и в схему настроек (contracts) ему попадать незачем.
   */
  secretBackupVerifier?: string;
}

const DEFAULT_STATE: AppState = {
  groups: [],
  automations: [],
  disabled: { rule: [], hook: [], skill: [], mcp: [], permission: [] },
  disabledByGroup: { rule: {}, hook: {}, skill: {}, mcp: {}, permission: {} },
  disabledHooks: {},
  envByGroup: {},
  projects: [],
  runnerCommands: {},
  runnerPrefs: {},
  providerChecks: {},
  settings: {
    theme: 'system',
    language: 'ru',
    accent: 'default',
    provider: 'claude',
    onboardingDone: false,
    claudeDirOverride: '',
    revealSecretsByDefault: false,
    backupBeforeWrite: true,
    backupKeep: 10,
    watchFiles: true,
    largeText: false,
    reduceMotion: false,
    highContrast: false,
    editor: '',
    costUnit: 'tokens',
    mcpNetworkTimeoutMs: 10_000,
    mcpAutoCheck: false,
    chatModel: '',
    chatEffort: 'xhigh',
    modelPricing: {},
    encryptSecretBackups: false,
    autoUpdateModels: true,
    previewProviderWrites: true,
  },
};

export class AppStore {
  private state: AppState;
  private readonly appDataDir: string;

  constructor(appDataDir: string) {
    // Node исполняет TypeScript в режиме strip-only: он только срезает типы и
    // не поддерживает parameter properties, поэтому поле присваиваем вручную.
    this.appDataDir = appDataDir;
    this.state = this.load();
  }

  private get stateFile(): string {
    return join(this.appDataDir, 'state.json');
  }

  get backupDir(): string {
    return join(this.appDataDir, 'backups');
  }

  private load(): AppState {
    const loaded = readJsonFile<Partial<AppState>>(this.stateFile, {});
    // Клонируем дефолт целиком. Иначе при пустом state.json вложенные массивы
    // (groups, automations, disabled.hook и т.д.) остаются ОБЩЕЙ ссылкой с
    // модульным DEFAULT_STATE, и мутации одного стора (setEnabled/saveGroup)
    // протекают в другие экземпляры и в сам дефолт — а экземпляров несколько
    // (песочницы, смена целевого каталога через claudeDirOverride).
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
      settings: { ...base.settings, ...loaded.settings },
    };
  }

  private persist(): void {
    writeJsonFile(this.stateFile, this.state);
  }

  getState(): AppState {
    return this.state;
  }

  /** Полный снимок состояния панели — для переноса на другую машину. */
  exportState(): AppState {
    return structuredClone(this.state);
  }

  /**
   * Заменить состояние импортом. Сливаем с дефолтами теми же правилами, что и
   * при загрузке: чужой файл может быть неполным или из старой версии, а панель
   * не должна на нём падать.
   */
  importState(raw: unknown): void {
    const loaded = (raw ?? {}) as Partial<AppState>;
    const base = structuredClone(DEFAULT_STATE);
    this.state = {
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
      settings: { ...base.settings, ...loaded.settings },
    };
    this.persist();
  }

  getSettings(): AppSettings {
    return this.state.settings;
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.state.settings = { ...this.state.settings, ...patch };
    this.persist();
    return this.state.settings;
  }

  /** Итоги проверки провайдеров: id → последний результат (копия, не внутренний объект). */
  getProviderChecks(): Record<string, ProviderCheckResult> {
    return structuredClone(this.state.providerChecks);
  }

  /** Запомнить итог проверки провайдера, заменив предыдущий. */
  saveProviderCheck(result: ProviderCheckResult): void {
    this.state.providerChecks[result.provider] = result;
    this.persist();
  }

  /** Verifier парольной фразы шифрования копий секретов (или undefined, если не задан). */
  getSecretBackupVerifier(): string | undefined {
    return this.state.secretBackupVerifier;
  }

  /** Сохранить/очистить verifier парольной фразы. Сама фраза на диск не пишется. */
  setSecretBackupVerifier(verifier: string | undefined): void {
    if (verifier) this.state.secretBackupVerifier = verifier;
    else delete this.state.secretBackupVerifier;
    this.persist();
  }

  /**
   * Итоговое состояние: выключено вручную либо погашено хотя бы одной группой.
   *
   * `legacyId` — прежний идентификатор той же сущности. Хуки перешли с
   * позиционных id на контентные, и без этой сверки все отметки, сделанные до
   * перехода, разом перестали бы находиться: выключенные хуки включились бы
   * сами собой.
   */
  isDisabled(kind: EntityKind, id: string, legacyId?: string): boolean {
    return (
      this.isDisabledManually(kind, id) ||
      this.disablingGroups(kind, id).length > 0 ||
      (legacyId !== undefined &&
        (this.isDisabledManually(kind, legacyId) ||
          this.disablingGroups(kind, legacyId).length > 0))
    );
  }

  isDisabledManually(kind: EntityKind, id: string): boolean {
    return this.state.disabled[kind].includes(id);
  }

  /** Какие именно группы сейчас гасят сущность — нужно интерфейсу и логике включения. */
  disablingGroups(kind: EntityKind, id: string): string[] {
    return this.state.disabledByGroup[kind][id] ?? [];
  }

  /**
   * `legacyId` убирается из отметок при любой правке: переключили сущность —
   * значит её состояние записано уже по новому идентификатору, и старая
   * запись только копила бы мусор и мешала бы включению.
   */
  setEnabled(kind: EntityKind, id: string, isEnabled: boolean, legacyId?: string): void {
    const list = this.state.disabled[kind];

    if (legacyId) {
      const stale = list.indexOf(legacyId);
      if (stale >= 0) list.splice(stale, 1);
    }

    const index = list.indexOf(id);
    if (isEnabled && index >= 0) list.splice(index, 1);
    if (!isEnabled && index < 0) list.push(id);
    this.persist();
  }

  /**
   * Перенести все отметки сущности со старого идентификатора на новый — при
   * переименовании (у скилла id = имя папки). Трогаем каждое место, где id
   * участвует: ручное выключение, гашение группой и состав групп. Иначе после
   * смены папки отметки остались бы висеть на несуществующем id.
   */
  renameEntity(kind: EntityKind, oldId: string, newId: string): void {
    if (oldId === newId) return;

    const disabled = this.state.disabled[kind];
    const at = disabled.indexOf(oldId);
    if (at >= 0) {
      disabled.splice(at, 1);
      if (!disabled.includes(newId)) disabled.push(newId);
    }

    const byGroup = this.state.disabledByGroup[kind];
    if (byGroup[oldId]) {
      byGroup[newId] = byGroup[oldId];
      delete byGroup[oldId];
    }

    for (const group of this.state.groups) {
      for (const member of group.members) {
        if (member.kind === kind && member.id === oldId) member.id = newId;
      }
    }

    this.persist();
  }

  /**
   * Отметка «эту сущность гасит вот эта группа». Пустой список удаляем целиком,
   * иначе state.json копил бы записи обо всех когда-либо выключенных группах.
   */
  setGroupDisabled(kind: EntityKind, id: string, groupId: string, isDisabled: boolean): void {
    const byId = this.state.disabledByGroup[kind];
    const groups = new Set(byId[id] ?? []);

    if (isDisabled) groups.add(groupId);
    else groups.delete(groupId);

    if (groups.size > 0) byId[id] = [...groups];
    else delete byId[id];

    this.persist();
  }

  /** Какие ключи env применила группа (записала в settings.json). */
  getGroupEnvKeys(groupId: string): string[] {
    return this.state.envByGroup[groupId] ?? [];
  }

  /** Запомнить/очистить набор ключей env, применённых группой. */
  setGroupEnvKeys(groupId: string, keys: string[]): void {
    if (keys.length > 0) this.state.envByGroup[groupId] = [...keys];
    else delete this.state.envByGroup[groupId];
    this.persist();
  }

  /** Держит ли этот ключ env хоть одна группа (кроме, если задано, `exceptId`). */
  isEnvKeyOwnedByGroup(key: string, exceptId?: string): boolean {
    for (const [groupId, keys] of Object.entries(this.state.envByGroup)) {
      if (groupId === exceptId) continue;
      if (keys.includes(key)) return true;
    }
    return false;
  }

  /**
   * Запомнить команду хука перед тем, как он исчезнет из settings.json.
   * Без этого выключение хука было бы его удалением: файл — единственное
   * место, где живёт текст команды.
   */
  rememberDisabledHook(hook: Hook): void {
    this.state.disabledHooks[hook.id] = hook;
    this.persist();
  }

  getDisabledHooks(): Hook[] {
    return Object.values(this.state.disabledHooks);
  }

  /**
   * Убрать снимки хуков, которые снова лежат в файле. Вызывается ПОСЛЕ
   * перезаписи settings.json: сотри снимок раньше — и включать будет нечего.
   */
  pruneDisabledHooks(idsBackInFile: string[]): void {
    for (const id of idsBackInFile) delete this.state.disabledHooks[id];
    this.persist();
  }

  getGroups(): Group[] {
    return [...this.state.groups].sort((a, b) => a.order - b.order);
  }

  /**
   * Группы, в которые входит сущность — для отображения меток в списках.
   * `legacyId` сверяется тоже: состав групп записан до перехода хуков на
   * контентные идентификаторы, и иначе группа потеряла бы участников.
   */
  getGroupIdsFor(kind: EntityKind, id: string, legacyId?: string): string[] {
    return this.state.groups
      .filter((group) =>
        group.members.some(
          (member) =>
            member.kind === kind && (member.id === id || (legacyId && member.id === legacyId)),
        ),
      )
      .map((group) => group.id);
  }

  saveGroup(group: Group): Group {
    const index = this.state.groups.findIndex((item) => item.id === group.id);
    if (index >= 0) this.state.groups[index] = group;
    else this.state.groups.push(group);
    this.persist();
    return group;
  }

  deleteGroup(id: string): void {
    this.state.groups = this.state.groups.filter((group) => group.id !== id);
    this.persist();
  }

  getAutomations(): Automation[] {
    return this.state.automations;
  }

  saveAutomation(automation: Automation): Automation {
    const index = this.state.automations.findIndex((item) => item.id === automation.id);
    if (index >= 0) this.state.automations[index] = automation;
    else this.state.automations.push(automation);
    this.persist();
    return automation;
  }

  deleteAutomation(id: string): void {
    this.state.automations = this.state.automations.filter((item) => item.id !== id);
    this.persist();
  }

  // --- Реестр проектов уровня конфигурации ---

  getProjects(): Project[] {
    return [...this.state.projects];
  }

  getProject(id: string): Project | undefined {
    return this.state.projects.find((project) => project.id === id);
  }

  /**
   * Добавить проект в реестр. Один и тот же каталог не заводим дважды: если он
   * уже запомнен, возвращаем существующую запись (и обновляем имя, если задано),
   * а не плодим дубликаты с разными id.
   */
  addProject(project: Project): Project {
    const existing = this.state.projects.find(
      (item) => normalizeProjectPath(item.path) === normalizeProjectPath(project.path),
    );
    if (existing) {
      existing.name = project.name;
      this.persist();
      return existing;
    }

    this.state.projects.push(project);
    this.persist();
    return project;
  }

  /** Убрать проект из реестра. Файлы проекта при этом не трогаем — только путь. */
  removeProject(id: string): void {
    this.state.projects = this.state.projects.filter((project) => project.id !== id);
    this.persist();
  }

  // --- Что панель помнит про цели запуска dev-серверов ---

  /**
   * Оверрайд команды запуска для каталога цели (или undefined, если не задан).
   *
   * Читается и из старой карты `runnerCommands`: до появления подпапок оверрайд
   * жил там, и терять его при обновлении панели незачем. Запись всегда идёт
   * в `runnerPrefs` — старая карта только дочитывается.
   */
  getRunnerCommand(path: string): string | undefined {
    const key = normalizeProjectPath(path);
    return this.state.runnerPrefs[key]?.command || this.state.runnerCommands[key] || undefined;
  }

  /** Сохранить/очистить оверрайд команды запуска для каталога цели. */
  setRunnerCommand(path: string, command: string | undefined, meta: RunnerTargetMeta = {}): void {
    const trimmed = command?.trim();
    this.updateRunnerPrefs(path, meta, (prefs) => {
      if (trimmed) prefs.command = trimmed;
      else delete prefs.command;
    });
    // Старая запись больше не нужна: значение переехало в runnerPrefs.
    delete this.state.runnerCommands[normalizeProjectPath(path)];
    this.persist();
  }

  /** Что панель помнит о запуске этой цели (пусто — ничего). */
  getRunnerPrefs(path: string): RunnerPrefs | undefined {
    return this.state.runnerPrefs[normalizeProjectPath(path)];
  }

  /**
   * Включить/выключить автозапуск цели. Выключение НЕ забывает ни порт, ни
   * команду: тумблер вернут — всё останется прежним.
   */
  setRunnerAutostart(path: string, autostart: boolean, meta: RunnerTargetMeta = {}): void {
    this.updateRunnerPrefs(path, meta, (prefs) => {
      if (autostart) prefs.autostart = true;
      else delete prefs.autostart;
    });
    this.persist();
  }

  /**
   * Снять автозапуск со ВСЕХ целей проекта — закрытая вкладка не должна
   * оставлять после себя обещание что-то поднять при следующем старте.
   */
  clearRunnerAutostart(projectPath: string): void {
    const root = normalizeProjectPath(projectPath);
    for (const [key, prefs] of Object.entries(this.state.runnerPrefs)) {
      const owner = normalizeProjectPath(prefs.projectPath ?? prefs.path);
      if (owner !== root && key !== root) continue;
      this.updateRunnerPrefs(prefs.path, prefs, (next) => delete next.autostart);
    }
    this.persist();
  }

  /** Закрепить порт цели (или снять закрепление). */
  setRunnerPort(path: string, port: number | undefined, meta: RunnerTargetMeta = {}): void {
    this.updateRunnerPrefs(path, meta, (prefs) => {
      if (port && Number.isInteger(port) && port > 0 && port < 65_536) prefs.pinnedPort = port;
      else delete prefs.pinnedPort;
    });
    this.persist();
  }

  /** Запомнить порт удачного запуска — он показывается как подсказка. */
  rememberRunnerPort(path: string, port: number, meta: RunnerTargetMeta = {}): void {
    const current = this.getRunnerPrefs(path);
    if (current?.port === port) return;
    this.updateRunnerPrefs(path, meta, (prefs) => {
      prefs.port = port;
    });
    this.persist();
  }

  /** Цели с включённым автозапуском — их поднимает старт сервера панели. */
  listAutostartProjects(): RunnerPrefs[] {
    return Object.values(this.state.runnerPrefs).filter((prefs) => prefs.autostart);
  }

  /**
   * Общая правка записи о цели: запись без единого осмысленного поля удаляется
   * целиком, иначе `state.json` копил бы пустышки от каждого касания.
   * Персист вызывает вызывающий — иначе массовые правки писали бы файл по разу
   * на цель.
   */
  private updateRunnerPrefs(
    path: string,
    meta: RunnerTargetMeta,
    mutate: (prefs: RunnerPrefs) => void,
  ): void {
    const key = normalizeProjectPath(path);
    const next: RunnerPrefs = { ...this.state.runnerPrefs[key], path };
    if (meta.projectPath) next.projectPath = meta.projectPath;
    if (meta.dir) next.dir = meta.dir;
    mutate(next);

    const isEmpty =
      !next.autostart && next.port === undefined && next.pinnedPort === undefined && !next.command;
    if (isEmpty) delete this.state.runnerPrefs[key];
    else this.state.runnerPrefs[key] = next;
  }
}

/** Нормализация пути для сравнения: Windows нечувствителен к регистру и слэшам. */
function normalizeProjectPath(path: string): string {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}
