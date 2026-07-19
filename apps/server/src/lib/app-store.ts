import { join } from 'node:path';
import type { AppSettings, Automation, EntityKind, Group } from '@claude-control/contracts';
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
  settings: AppSettings;
}

const DEFAULT_STATE: AppState = {
  groups: [],
  automations: [],
  disabled: { rule: [], hook: [], skill: [], mcp: [], permission: [] },
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
    return {
      ...DEFAULT_STATE,
      ...loaded,
      disabled: { ...DEFAULT_STATE.disabled, ...loaded.disabled },
      settings: { ...DEFAULT_STATE.settings, ...loaded.settings },
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

  isDisabled(kind: EntityKind, id: string): boolean {
    return this.state.disabled[kind].includes(id);
  }

  setEnabled(kind: EntityKind, id: string, isEnabled: boolean): void {
    const list = this.state.disabled[kind];
    const index = list.indexOf(id);
    if (isEnabled && index >= 0) list.splice(index, 1);
    if (!isEnabled && index < 0) list.push(id);
    this.persist();
  }

  getGroups(): Group[] {
    return [...this.state.groups].sort((a, b) => a.order - b.order);
  }

  /** Группы, в которые входит сущность — для отображения меток в списках. */
  getGroupIdsFor(kind: EntityKind, id: string): string[] {
    return this.state.groups
      .filter((group) => group.members.some((member) => member.kind === kind && member.id === id))
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
