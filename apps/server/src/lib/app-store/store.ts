import { join } from 'node:path';
import type {
  AppSettings,
  Automation,
  EntityKind,
  Group,
  Hook,
  Project,
  ProjectCodeLayout,
  ProjectCodeView,
  ProviderCheckResult,
  PushDevice,
} from '@claude-control/contracts';
import { writeJsonFile } from '../safe-io.ts';
import {
  addPushDevice as writePushDevice,
  getPushDevices as readPushDevices,
  removePushDevice as dropPushDevice,
} from './devices.ts';
import {
  forgetCodeView as dropCodeView,
  getCodeLayout as readCodeLayout,
  getCodeView as readCodeView,
  setCodeLayout as writeCodeLayout,
  setCodeView as writeCodeView,
} from './code-view.ts';
import type { AppState, RunnerPrefs, RunnerTargetMeta } from './app-store.types.ts';
import { mergeState, readStateFile, stateFilePath } from './state-file.ts';
import {
  disablingGroups as entityDisablingGroups,
  isDisabled as isEntityDisabled,
  isDisabledManually as isEntityDisabledManually,
  removeEntity as removeEntityMarks,
  renameEntity as renameEntityMarks,
  setEnabled as setEntityEnabled,
  setGroupDisabled as setEntityGroupDisabled,
} from './entities.ts';
import {
  getDisabledHooks as listHookSnapshots,
  pruneDisabledHooks as pruneHookSnapshots,
  rememberDisabledHook as rememberHookSnapshot,
} from './disabled-hooks.ts';
import {
  deleteGroup as deleteGroupRecord,
  getGroupEnvKeys as readGroupEnvKeys,
  groupIdsFor,
  isEnvKeyOwnedByGroup as isEnvKeyHeldByGroup,
  listGroups,
  saveGroup as saveGroupRecord,
  setGroupEnvKeys as writeGroupEnvKeys,
} from './groups.ts';
import {
  addProject as addProjectRecord,
  findProject,
  listProjects,
  removeProject as removeProjectRecord,
} from './projects.ts';
import {
  clearRunnerAutostart as clearAutostartMarks,
  getRunnerCommand as readRunnerCommand,
  getRunnerPrefs as readRunnerPrefs,
  listAutostartProjects as listAutostartTargets,
  rememberRunnerPort as writeRunnerPortHint,
  setRunnerAutostart as writeRunnerAutostart,
  setRunnerCommand as writeRunnerCommand,
  setRunnerPort as writeRunnerPort,
} from './runner.ts';

/**
 * Состояние панели поверх файла `state.json`: единственная точка чтения и
 * записи. Каждый срез состояния (отметки выключения, снимки хуков, группы,
 * проекты, цели запуска) живёт своим модулем рядом, а класс держит сам объект
 * состояния и решает, когда файл переписывается.
 */
export class AppStore {
  private state: AppState;
  private readonly appDataDir: string;

  constructor(appDataDir: string) {
    // Node исполняет TypeScript в режиме strip-only: он только срезает типы и
    // не поддерживает parameter properties, поэтому поле присваиваем вручную.
    this.appDataDir = appDataDir;
    this.state = mergeState(readStateFile(appDataDir));
  }

  private get stateFile(): string {
    return stateFilePath(this.appDataDir);
  }

  get backupDir(): string {
    return join(this.appDataDir, 'backups');
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
    this.state = mergeState((raw ?? {}) as Partial<AppState>);
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

  /** Телефоны, которым уходят уведомления о прогонах. */
  getPushDevices(): PushDevice[] {
    return readPushDevices(this.state);
  }

  /** Приложение прислало свой push-токен — запомнить или обновить запись. */
  addPushDevice(device: PushDevice): PushDevice[] {
    const devices = writePushDevice(this.state, device);
    this.persist();
    return devices;
  }

  /** Отвязать телефон: руками из панели или потому, что токен больше не живой. */
  removePushDevice(token: string): boolean {
    const removed = dropPushDevice(this.state, token);
    if (removed) this.persist();
    return removed;
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

  isDisabled(kind: EntityKind, id: string, legacyId?: string): boolean {
    return isEntityDisabled(this.state, kind, id, legacyId);
  }

  isDisabledManually(kind: EntityKind, id: string): boolean {
    return isEntityDisabledManually(this.state, kind, id);
  }

  disablingGroups(kind: EntityKind, id: string): string[] {
    return entityDisablingGroups(this.state, kind, id);
  }

  setEnabled(kind: EntityKind, id: string, isEnabled: boolean, legacyId?: string): void {
    setEntityEnabled(this.state, kind, id, isEnabled, legacyId);
    this.persist();
  }

  renameEntity(kind: EntityKind, oldId: string, newId: string): void {
    if (renameEntityMarks(this.state, kind, oldId, newId)) this.persist();
  }

  removeEntity(kind: EntityKind, id: string): void {
    if (removeEntityMarks(this.state, kind, id)) this.persist();
  }

  setGroupDisabled(kind: EntityKind, id: string, groupId: string, isDisabled: boolean): void {
    setEntityGroupDisabled(this.state, kind, id, groupId, isDisabled);
    this.persist();
  }

  getGroupEnvKeys(groupId: string): string[] {
    return readGroupEnvKeys(this.state, groupId);
  }

  setGroupEnvKeys(groupId: string, keys: string[]): void {
    writeGroupEnvKeys(this.state, groupId, keys);
    this.persist();
  }

  isEnvKeyOwnedByGroup(key: string, exceptId?: string): boolean {
    return isEnvKeyHeldByGroup(this.state, key, exceptId);
  }

  rememberDisabledHook(hook: Hook): void {
    rememberHookSnapshot(this.state, hook);
    this.persist();
  }

  getDisabledHooks(): Hook[] {
    return listHookSnapshots(this.state);
  }

  pruneDisabledHooks(idsBackInFile: string[]): void {
    pruneHookSnapshots(this.state, idsBackInFile);
    this.persist();
  }

  getGroups(): Group[] {
    return listGroups(this.state);
  }

  getGroupIdsFor(kind: EntityKind, id: string, legacyId?: string): string[] {
    return groupIdsFor(this.state, kind, id, legacyId);
  }

  saveGroup(group: Group): Group {
    const saved = saveGroupRecord(this.state, group);
    this.persist();
    return saved;
  }

  deleteGroup(id: string): void {
    deleteGroupRecord(this.state, id);
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
    return listProjects(this.state);
  }

  getProject(id: string): Project | undefined {
    return findProject(this.state, id);
  }

  addProject(project: Project): Project {
    const stored = addProjectRecord(this.state, project);
    this.persist();
    return stored;
  }

  removeProject(id: string): void {
    removeProjectRecord(this.state, id);
    this.persist();
  }

  // --- Что панель помнит про цели запуска dev-серверов ---

  getRunnerCommand(path: string): string | undefined {
    return readRunnerCommand(this.state, path);
  }

  setRunnerCommand(path: string, command: string | undefined, meta: RunnerTargetMeta = {}): void {
    writeRunnerCommand(this.state, path, command, meta);
    this.persist();
  }

  getRunnerPrefs(path: string): RunnerPrefs | undefined {
    return readRunnerPrefs(this.state, path);
  }

  setRunnerAutostart(path: string, autostart: boolean, meta: RunnerTargetMeta = {}): void {
    writeRunnerAutostart(this.state, path, autostart, meta);
    this.persist();
  }

  clearRunnerAutostart(projectPath: string): void {
    clearAutostartMarks(this.state, projectPath);
    this.persist();
  }

  setRunnerPort(path: string, port: number | undefined, meta: RunnerTargetMeta = {}): void {
    writeRunnerPort(this.state, path, port, meta);
    this.persist();
  }

  rememberRunnerPort(path: string, port: number, meta: RunnerTargetMeta = {}): void {
    if (writeRunnerPortHint(this.state, path, port, meta)) this.persist();
  }

  listAutostartProjects(): RunnerPrefs[] {
    return listAutostartTargets(this.state);
  }

  getCodeLayout(): ProjectCodeLayout {
    return readCodeLayout(this.state);
  }

  setCodeLayout(layout: ProjectCodeLayout): void {
    writeCodeLayout(this.state, layout);
    this.persist();
  }

  getCodeView(path: string): ProjectCodeView | undefined {
    return readCodeView(this.state, path);
  }

  setCodeView(path: string, view: ProjectCodeView): void {
    writeCodeView(this.state, path, view);
    this.persist();
  }

  forgetCodeView(path: string): void {
    if (dropCodeView(this.state, path)) this.persist();
  }
}
