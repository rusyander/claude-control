import { join } from 'node:path';
import type { AppSettings, Automation, EntityKind, Group, Hook } from '@claude-control/contracts';
import { readJsonFile, writeJsonFile } from './safe-io.ts';

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
  settings: AppSettings;
}

const DEFAULT_STATE: AppState = {
  groups: [],
  automations: [],
  disabled: { rule: [], hook: [], skill: [], mcp: [], permission: [] },
  disabledByGroup: { rule: {}, hook: {}, skill: {}, mcp: {}, permission: {} },
  disabledHooks: {},
  settings: {
    theme: 'system',
    language: 'ru',
    claudeDirOverride: '',
    revealSecretsByDefault: false,
    backupBeforeWrite: true,
    watchFiles: true,
    largeText: false,
    reduceMotion: false,
    highContrast: false,
    editor: '',
    costUnit: 'tokens',
    chatModel: '',
    chatEffort: 'xhigh',
    modelPricing: {},
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
      settings: { ...base.settings, ...loaded.settings },
    };
  }

  private persist(): void {
    writeJsonFile(this.stateFile, this.state);
  }

  getState(): AppState {
    return this.state;
  }

  getSettings(): AppSettings {
    return this.state.settings;
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.state.settings = { ...this.state.settings, ...patch };
    this.persist();
    return this.state.settings;
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
}
