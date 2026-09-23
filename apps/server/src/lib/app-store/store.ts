import { join } from 'node:path';
import type { FidelityMark } from '@agentdeck/contracts/portable-fidelity';
import type { EnvSubscription } from '@agentdeck/contracts/portable-subscribe';
import type { TransferRecord } from '@agentdeck/contracts/portable-transfer';
import type { SplitSettings } from '@agentdeck/contracts/task-split';
import type {
  AppSettings,
  Automation,
  EntityKind,
  Group,
  Hook,
  IntegrationLink,
  IntegrationLinks,
  WorktreeMirrorSettings,
  PlatformActivationNotice,
  PlatformAppliedRecord,
  PlatformHealthRecord,
  PlatformSmokeResult,
  PlatformSpendRecord,
  Project,
  ProjectCodeLayout,
  ProjectCodeView,
  ProviderCheckResult,
  PushDevice,
} from '@agentdeck/contracts';
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
import {
  projectCascadeEntries as readCascadeEntries,
  setProjectCascade as writeProjectCascade,
} from './cascade.ts';
import {
  isTestsAutoAccept as readTestsAutoAccept,
  setTestsAutoAccept as writeTestsAutoAccept,
} from './tests-drafts.ts';
import {
  clearChatLink as dropChatLink,
  getChatLink as readChatLink,
  getChatLinks as readChatLinks,
  linkChatSession as moveChatLink,
  markChatFirstEdit as stampFirstEdit,
  setChatLink as writeChatLink,
} from './chat-links.ts';
import {
  clearTreePause as dropTreePause,
  getTreePause as readTreePause,
  getTreePauses as readTreePauses,
  setTreePause as writeTreePause,
} from './tree-pause.ts';
import {
  findSplitPlanByTriage as readSplitPlanByTriage,
  getSplitPlan as readSplitPlan,
  getSplitPlans as readSplitPlans,
  setSplitPlan as writeSplitPlan,
} from './split-plans.ts';
import type {
  AppState,
  ChatLink,
  TreePauseRecord,
  SplitPlanRecord,
  IntegrationHealthRecord,
  McpHealthRecord,
  RunnerPrefs,
  RunnerTargetMeta,
} from './app-store.types.ts';
import {
  forgetIntegrationHealth as dropIntegrationHealth,
  getIntegrationHealth as readIntegrationHealth,
  saveIntegrationHealth as writeIntegrationHealth,
} from './integration-health.ts';
import {
  forgetPlatformHealth as dropPlatformHealth,
  getPlatformHealth as readPlatformHealth,
  savePlatformHealth as writePlatformHealth,
} from './platform-health.ts';
import {
  forgetPlatformApplied as dropPlatformApplied,
  getPlatformApplied as readPlatformApplied,
  savePlatformApplied as writePlatformApplied,
} from './platform-applied.ts';
import {
  getPortabilityFidelity as readPortabilityFidelity,
  savePortabilityFidelity as writePortabilityFidelity,
} from './portability-fidelity.ts';
import {
  forgetPortabilitySubscription as dropPortabilitySubscription,
  getPortabilitySubscription as readPortabilitySubscription,
  getPortabilitySubscriptions as readPortabilitySubscriptions,
  savePortabilitySubscription as writePortabilitySubscription,
} from './portability-subscriptions.ts';
import {
  forgetPortabilityTransfer as dropPortabilityTransfer,
  getPortabilityTransfer as readPortabilityTransfer,
  savePortabilityTransfer as writePortabilityTransfer,
} from './portability-transfer.ts';
import {
  forgetPlatformSpend as dropPlatformSpend,
  getPlatformSpend as readPlatformSpend,
  savePlatformSpend as writePlatformSpend,
} from './platform-spend.ts';
import {
  clearPlatformActivationNotice as dropPlatformActivationNotice,
  forgetPlatformSmoke as dropPlatformSmoke,
  getPlatformActivationNotice as readPlatformActivationNotice,
  getPlatformSmoke as readPlatformSmoke,
  savePlatformSmoke as writePlatformSmoke,
  setPlatformActivationNotice as writePlatformActivationNotice,
} from './platform-activation.ts';
import {
  getAllIntegrationLinks as readAllIntegrationLinks,
  getIntegrationLinks as readIntegrationLinks,
  removeIntegrationLink as dropIntegrationLink,
  setIntegrationLink as writeIntegrationLink,
} from './integration-links.ts';
import {
  mergeState,
  readStateFile,
  stateFilePath,
  withCurrentPlatformDrivers,
} from './state-file.ts';
import {
  getWorktreeMirror as readWorktreeMirror,
  setWorktreeMirror as writeWorktreeMirror,
} from './worktree-mirror.ts';
import {
  getSplitSettings as readSplitSettings,
  setSplitSettings as writeSplitSettings,
} from './split-settings.ts';
import {
  forgetMcpHealth as dropMcpHealth,
  getMcpHealth as readMcpHealth,
  renameMcpHealth as moveMcpHealth,
  saveMcpHealth as writeMcpHealth,
} from './mcp-health.ts';
import {
  disabledIds as entityDisabledIds,
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
  findProjectByPath,
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
    const loaded = readStateFile(appDataDir);
    this.state = mergeState(loaded);
    // Контур под прежним именем драйвера переписывается на диске сразу, один раз.
    if (withCurrentPlatformDrivers(loaded).changed) this.persist();
  }

  private get stateFile(): string {
    return stateFilePath(this.appDataDir);
  }

  get backupDir(): string {
    return join(this.appDataDir, 'backups');
  }

  /** Отстранённая копия (`detached`): живёт только в памяти, файла не касается. */
  private isDetached?: boolean;

  private persist(): void {
    if (this.isDetached) return;
    writeJsonFile(this.stateFile, this.state);
  }

  /**
   * Копия состояния, которая НИКОГДА не пишет `state.json`. Нужна предпросмотру
   * записи: доменная операция идёт по временной копии файла и попутно переносит
   * отметки (`migrateRuleIds`, `removeEntity`). По настоящему хранилищу это
   * сдвинуло бы отметки живого конфига ещё до того, как человек что-то решил.
   */
  detached(): AppStore {
    const copy = Object.create(AppStore.prototype) as AppStore;
    Object.assign(copy, {
      appDataDir: this.appDataDir,
      state: structuredClone(this.state),
      isDetached: true,
    });
    return copy;
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

  /** Все погашенные идентификаторы вида — ручные и групповые отметки вместе. */
  getDisabledIds(kind: EntityKind): string[] {
    return entityDisabledIds(this.state, kind);
  }

  setEnabled(kind: EntityKind, id: string, isEnabled: boolean, legacyId?: string): void {
    setEntityEnabled(this.state, kind, id, isEnabled, legacyId);
    this.persist();
  }

  renameEntity(kind: EntityKind, oldId: string, newId: string): void {
    const marksMoved = renameEntityMarks(this.state, kind, oldId, newId);
    // Итог проверки связи ключуется тем же именем — переезжает вместе с отметками.
    const healthMoved = kind === 'mcp' && moveMcpHealth(this.state, oldId, newId);
    if (marksMoved || healthMoved) this.persist();
  }

  removeEntity(kind: EntityKind, id: string): void {
    const marksDropped = removeEntityMarks(this.state, kind, id);
    const healthDropped = kind === 'mcp' && dropMcpHealth(this.state, id);
    if (marksDropped || healthDropped) this.persist();
  }

  /** Итог последней проверки связи MCP-серверов: имя → запись (копия, не внутренний объект). */
  getMcpHealth(): Record<string, McpHealthRecord> {
    return readMcpHealth(this.state);
  }

  /** Запомнить итог проверки связи сервера, заменив предыдущий. */
  saveMcpHealth(id: string, record: McpHealthRecord): void {
    writeMcpHealth(this.state, id, record);
    this.persist();
  }

  /**
   * Забыть итог проверки. Нужен при создании сервера под именем, которое раньше носил другой
   * (удалён руками в ~/.claude.json или через `claude mcp remove`, минуя панель): новый сервер
   * не должен наследовать чужое «отвечает, 3 инструмента, проверено вчера».
   */
  forgetMcpHealth(id: string): void {
    if (dropMcpHealth(this.state, id)) this.persist();
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

  /** Тот же каталог под другим регистром или слэшами — тот же проект. */
  getProjectByPath(path: string): Project | undefined {
    return findProjectByPath(this.state, path);
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

  /**
   * Где выключен подбор модели под задачу. Отдаём весь список, а не ответ по
   * одному пути: рабочая папка прогона бывает подпапкой проекта и копией ветки,
   * и сопоставление живёт в домене (`domains/model-cascade.ts`).
   */
  getProjectCascadeEntries(): Array<[string, boolean]> {
    return readCascadeEntries(this.state);
  }

  setProjectCascade(path: string, enabled: boolean): void {
    writeProjectCascade(this.state, path, enabled);
    this.persist();
  }

  /** Принимать ли черновики генерации тестов этого проекта без просмотра. */
  isTestsAutoAccept(path: string): boolean {
    return readTestsAutoAccept(this.state, path);
  }

  setTestsAutoAccept(path: string, enabled: boolean): void {
    writeTestsAutoAccept(this.state, path, enabled);
    this.persist();
  }

  /** Все связи «родитель → потомок»: списку чатов нужны разом, а не по одной. */
  getChatLinks(): Record<string, ChatLink> {
    return readChatLinks(this.state);
  }

  getChatLink(chatId: string): ChatLink | undefined {
    return readChatLink(this.state, chatId);
  }

  setChatLink(chatId: string, link: ChatLink): void {
    writeChatLink(this.state, chatId, link);
    this.persist();
  }

  /**
   * Связь под ключом, которого не будет: звено уехало на настоящий ключ
   * разговора чужого провайдера. Молчит, когда связи нет, — зовут это на
   * каждом заведённом звене, а переезд бывает только у чужих.
   */
  clearChatLink(chatId: string): void {
    if (dropChatLink(this.state, chatId)) this.persist();
  }

  /**
   * Прогон назвал настоящий `sessionId` — переносим на него связь с временного
   * ключа. Зовётся на КАЖДОМ прогоне, поэтому молча ничего не делает, когда
   * связи нет: сохранять что-то на каждый чат панели здесь незачем.
   */
  linkChatSession(chatId: string, sessionId: string): void {
    if (moveChatLink(this.state, chatId, sessionId)) this.persist();
  }

  /** Первая правка кода в разговоре ребёнка — момент в связь; чужие прогоны молча мимо. */
  markChatFirstEdit(keys: readonly string[], at: string): void {
    if (stampFirstEdit(this.state, keys, at)) this.persist();
  }

  // --- Пауза дерева разговоров: корень → остановленные прогоны и отложенные автостарты ---

  getTreePauses(): Record<string, TreePauseRecord> {
    return readTreePauses(this.state);
  }

  getTreePause(root: string): TreePauseRecord | undefined {
    return readTreePause(this.state, root);
  }

  setTreePause(record: TreePauseRecord): void {
    writeTreePause(this.state, record);
    this.persist();
  }

  clearTreePause(root: string): void {
    if (dropTreePause(this.state, root)) this.persist();
  }

  // --- Конвейер уровней разделения (Т1): родитель → разбор, ожидания, группы.

  getSplitPlans(): Record<string, SplitPlanRecord> {
    return readSplitPlans(this.state);
  }

  getSplitPlan(parentChatId: string): SplitPlanRecord | undefined {
    return readSplitPlan(this.state, parentChatId);
  }

  findSplitPlanByTriage(chatIds: readonly string[]): SplitPlanRecord | undefined {
    return readSplitPlanByTriage(this.state, chatIds);
  }

  setSplitPlan(record: SplitPlanRecord): void {
    writeSplitPlan(this.state, record);
    this.persist();
  }

  // --- Внешние интеграции: итог проверки связи и привязки проектов ---

  /** Итоги последних проверок связи: id интеграции → запись (копия, не внутренний объект). */
  getIntegrationHealth(): Record<string, IntegrationHealthRecord> {
    return readIntegrationHealth(this.state);
  }

  saveIntegrationHealth(id: string, record: IntegrationHealthRecord): void {
    writeIntegrationHealth(this.state, id, record);
    this.persist();
  }

  /** Интеграцию забыли (сняли токен) — след проверки уходит вместе с ней. */
  forgetIntegrationHealth(id: string): void {
    if (dropIntegrationHealth(this.state, id)) this.persist();
  }

  // --- Контуры: итог последней пробы ---

  /** Итоги последних проб: id контура → запись (копия, не внутренний объект). */
  getPlatformHealth(): Record<string, PlatformHealthRecord> {
    return readPlatformHealth(this.state);
  }

  savePlatformHealth(id: string, record: PlatformHealthRecord): void {
    writePlatformHealth(this.state, id, record);
    this.persist();
  }

  /** Контур удалён — след пробы уходит вместе с ним. */
  forgetPlatformHealth(id: string): void {
    const tail = this.state.platformThinkTail;
    const hadTail = Boolean(tail && id in tail);
    if (tail && hadTail) delete tail[id];
    if (dropPlatformHealth(this.state, id) || hadTail) this.persist();
  }

  /** Модели контура, которые пишут размышления текстом до голого `</think>` (L9). */
  getThinkTailModels(platformId: string): readonly string[] {
    return this.state.platformThinkTail?.[platformId] ?? [];
  }

  /** Запомнить модель с голым `</think>`; повтор ничего не пишет. */
  markThinkTail(platformId: string, model: string): void {
    const known = this.state.platformThinkTail?.[platformId] ?? [];
    if (!model || known.includes(model)) return;
    this.state.platformThinkTail = {
      ...this.state.platformThinkTail,
      [platformId]: [...known, model],
    };
    this.persist();
  }

  // --- Контуры: след применения (Т3) ---

  /** Что и куда записано применением контура; копия, не внутренний объект. */
  getPlatformApplied(): Record<string, PlatformAppliedRecord> {
    return readPlatformApplied(this.state);
  }

  savePlatformApplied(id: string, record: PlatformAppliedRecord): void {
    writePlatformApplied(this.state, id, record);
    this.persist();
  }

  /** Контур отключён или удалён — след применения уходит вместе с ним. */
  forgetPlatformApplied(id: string): void {
    if (dropPlatformApplied(this.state, id)) this.persist();
  }

  // --- Перенос: отчёты верности (П1.2) ---

  /** Оттиски отчётов верности: «источник→цель:уровень» → сводка с датой (копия). */
  getPortabilityFidelity(): Record<string, FidelityMark> {
    return readPortabilityFidelity(this.state);
  }

  /**
   * Запомнить оттиск, ЕСЛИ обещание изменилось. Маршрут считает отчёт заново на
   * каждом запросе, и файл состояния писался бы на каждом открытии страницы —
   * запись только при изменении делает «прошлый раз» настоящим прошлым разом, а
   * не предыдущей секундой.
   */
  savePortabilityFidelity(key: string, mark: FidelityMark): void {
    if (writePortabilityFidelity(this.state, key, mark)) this.persist();
  }

  // --- Перенос: след применённого (П2.3) ---

  /** След последнего переноса к этой цели — по нему работает отмена (копия). */
  getPortabilityTransfer(key: string): TransferRecord | undefined {
    return readPortabilityTransfer(this.state, key);
  }

  /** Запомнить след. Пишется всегда: перенос — событие, а не пересчёт. */
  savePortabilityTransfer(key: string, record: TransferRecord): void {
    writePortabilityTransfer(this.state, key, record);
    this.persist();
  }

  /** Забыть след: перенос отменён целиком и возвращать больше нечего. */
  forgetPortabilityTransfer(key: string): void {
    dropPortabilityTransfer(this.state, key);
    this.persist();
  }

  // --- Перенос: подписки целей на канон (П5.1) ---

  /** Все подписки: «цель:уровень» → слои и память о спроецированном (копия). */
  getPortabilitySubscriptions(): Record<string, EnvSubscription> {
    return readPortabilitySubscriptions(this.state);
  }

  /** Подписка одной цели; её нет — `undefined`, а не пустая (копия). */
  getPortabilitySubscription(key: string): EnvSubscription | undefined {
    return readPortabilitySubscription(this.state, key);
  }

  /**
   * Запомнить подписку. Пишется всегда: и подписка, и пересборка — события, а
   * не пересчёт, и «мы это уже писали» здесь ничего не экономит.
   */
  savePortabilitySubscription(key: string, subscription: EnvSubscription): void {
    writePortabilitySubscription(this.state, key, subscription);
    this.persist();
  }

  /** Забыть подписку целиком. У цели при этом не удаляется ничего. */
  forgetPortabilitySubscription(key: string): void {
    dropPortabilitySubscription(this.state, key);
    this.persist();
  }

  // --- Контуры: расход по дням (Т8) ---

  /** Расход по контурам: id → дневные итоги (копия, не внутренний объект). */
  getPlatformSpend(): Record<string, PlatformSpendRecord> {
    return readPlatformSpend(this.state);
  }

  /**
   * Заменить запись расхода целиком. Складывает её домен, здесь — только запись
   * на диск, и зовут её ПАЧКОЙ: `persist` пишет весь `state.json` синхронно, а
   * шлюз считает расход на каждом ответе модели.
   */
  savePlatformSpend(record: PlatformSpendRecord): void {
    writePlatformSpend(this.state, record);
    this.persist();
  }

  /** Контур удалён — расход уходит вместе с ним. */
  forgetPlatformSpend(id: string): void {
    if (dropPlatformSpend(this.state, id)) this.persist();
  }

  // --- Контуры: активация (Т2) ---

  /** Итоги последних пробных запросов: id контура → ответ (копия, не внутренний объект). */
  getPlatformSmoke(): Record<string, PlatformSmokeResult> {
    return readPlatformSmoke(this.state);
  }

  savePlatformSmoke(id: string, result: PlatformSmokeResult): void {
    writePlatformSmoke(this.state, id, result);
    this.persist();
  }

  /** Контур удалён — след пробного запроса уходит вместе с ним. */
  forgetPlatformSmoke(id: string): void {
    if (dropPlatformSmoke(this.state, id)) this.persist();
  }

  /** Разовый рассказ о переносе старых настроек; пусто — переносить было нечего. */
  getPlatformActivationNotice(): PlatformActivationNotice | undefined {
    return readPlatformActivationNotice(this.state);
  }

  setPlatformActivationNotice(notice: PlatformActivationNotice): void {
    writePlatformActivationNotice(this.state, notice);
    this.persist();
  }

  /** Человек прочитал — сообщение уходит навсегда. */
  clearPlatformActivationNotice(): void {
    if (dropPlatformActivationNotice(this.state)) this.persist();
  }

  /**
   * Порт, занятый шлюзом контуров. Ноль — шлюз не поднят.
   *
   * Пишется слушателем при старте и остановке: снаружи (сторож стенда) узнать
   * ДОСТАВШИЙСЯ порт больше неоткуда, а задуманный совпадает с портом прокси
   * защиты данных.
   */
  setPlatformGatewayPort(port: number): void {
    if (this.state.platformGatewayPort === port) return;
    this.state.platformGatewayPort = port;
    this.persist();
  }

  getIntegrationLinks(path: string): IntegrationLinks {
    return readIntegrationLinks(this.state, path);
  }

  /** Что человек дописал к зеркалу копий этого репозитория; пусто — встроенное. */
  getWorktreeMirror(path: string): WorktreeMirrorSettings {
    return readWorktreeMirror(this.state, path);
  }

  setWorktreeMirror(path: string, settings: WorktreeMirrorSettings): WorktreeMirrorSettings {
    const next = writeWorktreeMirror(this.state, path, settings);
    this.persist();
    return next;
  }

  /** Разделение на проекте: доставка групп до MR и сколько их идёт разом. */
  getSplitSettings(path: string): SplitSettings {
    return readSplitSettings(this.state, path);
  }

  setSplitSettings(path: string, settings: SplitSettings): SplitSettings {
    const next = writeSplitSettings(this.state, path, settings);
    this.persist();
    return next;
  }

  /** Все привязки разом: активация MCP по началу прогона спрашивает именно так. */
  getAllIntegrationLinks(): Record<string, IntegrationLinks> {
    return readAllIntegrationLinks(this.state);
  }

  setIntegrationLink(
    path: string,
    groupId: string | undefined,
    link: IntegrationLink,
  ): IntegrationLinks {
    const links = writeIntegrationLink(this.state, path, groupId, link);
    this.persist();
    return links;
  }

  removeIntegrationLink(path: string, groupId?: string): IntegrationLinks {
    const links = dropIntegrationLink(this.state, path, groupId);
    this.persist();
    return links;
  }
}
