import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  kitTwinKinds,
  type KitTwinKind,
  type KitItem,
  type KitItemContent,
  type KitItemKind,
  type KitProviderView,
  type KitResponse,
} from '@agentdeck/contracts/kit';
import type { KitMode } from '@agentdeck/contracts/local-models';
import { readJsonFile, writeJsonFile, writeTextFile } from '../../lib/safe-io.ts';
import { diffLines, tooBig } from '../history/diff.ts';
import { buildCodexOverlay, CODEX_KIT_ENV, writeCodexOverlay } from './codex.ts';
import { composeKit, composeQwenHome } from './compose.ts';
import {
  exportToGlobal as exportTwin,
  globalItems,
  importFromGlobal as importTwin,
  sameText,
  twinMain,
  twinRoot,
  type TwinDirs,
} from './global-twin.ts';
import { describe, kitFiles, readText, type KitFile } from './items.ts';

/**
 * Встроенный набор панели (В2): режим на провайдер, копии «моё», выключенные
 * элементы, выбор в конфликте имён — и то, что из этого получает прогон.
 *
 * Состояние — `kit/` в данных панели. Файлы человека (`~/.claude`) набор не
 * пишет никогда: подключение — флагом запуска (`--plugin-dir`), и после
 * выключения следа нет.
 */

export const KIT_VARIANT_ENV = 'AGENTDECK_KIT_VARIANT';

/** Каталог плагина в приложении — версия набора едет вместе с панелью. */
export function builtinKitDir(): string {
  return fileURLToPath(new URL('../../../assets/kit/agentdeck-kit/', import.meta.url));
}

/** Наложение для Qwen Code (`variants/qwen`): его манифест `qwen-extension.json`. */
export function qwenVariantDir(): string {
  return fileURLToPath(new URL('../../../assets/kit/variants/qwen/', import.meta.url));
}

/** Кто и как получает набор. Остальные CLI слоя на прогон не дают — честный «нет». */
const SUPPORT: Record<string, { modes: KitMode[]; localOnly?: boolean; carries?: KitItemKind[] }> =
  {
    claude: { modes: ['global', 'hybrid', 'ours'] },
    // У Qwen Code нет слоя на один запуск: «Наши» — собственный `QWEN_HOME`, без
    // входа человека, поэтому только на контуре локальной модели; «оба набора» не
    // собрать, не трогая `~/.qwen`.
    qwen: { modes: ['global', 'ours'], localOnly: true },
    // Codex: наложение на запуск поверх ваших настроек (`domains/kit/codex.ts`) —
    // только «оба набора»: «только набор» требовал бы подменить `CODEX_HOME`.
    // Доезжают правила и навыки; пайплайнов и субагентов у Codex на запуск нет, а
    // хук без одобрения в `/hooks` самого Codex не сработает.
    codex: { modes: ['global', 'hybrid'], carries: ['rule', 'skill'] },
  };

interface KitState {
  modes: Record<string, KitMode>;
  disabled: string[];
  winners: Record<string, 'user' | 'kit'>;
}

const EMPTY: KitState = { modes: {}, disabled: [], winners: {} };

const REFUSALS = {
  'kit-item-unknown': 'В наборе панели нет такого элемента',
  'kit-mode-unsupported': 'Этот CLI такой режим набора не поддерживает',
  'kit-global-missing': 'В глобальном слое нет такого элемента',
  'kit-global-unsupported':
    'В глобальный слой и обратно переносятся только навыки, команды и субагенты',
  'kit-hooks-invalid': 'hooks.json не сохранён: это не JSON вида {"hooks": {…}}',
} as const;

function isHooksJson(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const hooks = (parsed as { hooks?: unknown }).hooks;
    return !!hooks && typeof hooks === 'object' && !Array.isArray(hooks);
  } catch {
    return false;
  }
}

const isTwinKind = (kind: string): kind is KitTwinKind =>
  (kitTwinKinds as readonly string[]).includes(kind);

/** Отказ с кодом текста: клиент переводит его по коду, а не по русской строке. */
export class KitRefusal extends Error {
  readonly code: keyof typeof REFUSALS;
  readonly messageCode: keyof typeof REFUSALS;

  constructor(code: keyof typeof REFUSALS) {
    super(REFUSALS[code]);
    this.code = code;
    this.messageCode = code;
  }
}

export interface KitServiceDeps {
  appDataDir: string;
  /** Каталог Claude человека — только чтение, для конфликтов имён. */
  claudeDir: () => string;
  providers: () => { id: string; name: string }[];
  builtinDir?: string;
  /** Резервные копии панели — сюда уходит прежняя версия при записи в глобальный слой. */
  backupDir?: string;
  /** Режимы из раздела «Локальная модель», где набор жил до В2. */
  legacyModes?: () => Partial<Record<string, KitMode>>;
  /** Дом Codex человека — только чтение его `developer_instructions`. */
  codexHome?: () => string;
}

export class KitService {
  private readonly deps: KitServiceDeps;
  private readonly root: string;
  private readonly builtin: string;

  constructor(deps: KitServiceDeps) {
    this.deps = deps;
    this.root = join(deps.appDataDir, 'kit');
    this.builtin = deps.builtinDir ?? builtinKitDir();
  }

  get mineDir(): string {
    return join(this.root, 'mine');
  }

  private get statePath(): string {
    return join(this.root, 'state.json');
  }

  private readState(): KitState {
    if (!existsSync(this.statePath)) {
      // Первый запуск после В2: режим, выбранный на странице локальной модели,
      // не должен молча вернуться к «Глобальным».
      const legacy = this.deps.legacyModes?.() ?? {};
      const modes = Object.fromEntries(
        Object.entries(legacy).filter(([, mode]) => mode && mode !== 'global'),
      ) as Record<string, KitMode>;
      return { ...EMPTY, modes };
    }
    const raw = readJsonFile<Partial<KitState>>(this.statePath, {});
    return {
      modes: raw.modes ?? {},
      disabled: Array.isArray(raw.disabled) ? raw.disabled : [],
      winners: raw.winners ?? {},
    };
  }

  private writeState(state: KitState): void {
    mkdirSync(this.root, { recursive: true });
    writeJsonFile(this.statePath, state);
  }

  modeOf(provider: string): KitMode {
    const mode = this.readState().modes[provider] ?? 'global';
    return SUPPORT[provider]?.modes.includes(mode) ? mode : 'global';
  }

  /**
   * Встроенные элементы и добавленные человеком — те, что есть только в «моё»
   * (взяты из глобального слоя). Хук так не добавляется: без записи в
   * `hooks.json` он не сработал бы.
   */
  private files(): KitFile[] {
    const builtin = kitFiles(this.builtin);
    const known = new Set(builtin.map((file) => file.id));
    const added = kitFiles(this.mineDir).filter(
      (file) => !known.has(file.id) && file.kind !== 'hook',
    );
    return [...builtin, ...added];
  }

  private twinDirs(): TwinDirs {
    return { builtinDir: this.builtin, mineDir: this.mineDir, globalDir: this.deps.claudeDir() };
  }

  /** Текст, который получает прогон: копия «моё», иначе встроенный. */
  private ownText(file: KitFile): string {
    const mine = join(this.mineDir, file.id);
    return readText(existsSync(mine) ? mine : join(this.builtin, file.id));
  }

  private fileById(id: string): KitFile {
    const file = this.files().find((item) => item.id === id);
    if (!file) throw new KitRefusal('kit-item-unknown');
    return file;
  }

  /** Одноимённый навык, команда или субагент у человека, если есть. */
  private userTwin(file: KitFile): string | undefined {
    if (!isTwinKind(file.kind)) return undefined;
    const path = join(this.deps.claudeDir(), twinMain(file.kind, file.name));
    return existsSync(path) ? path : undefined;
  }

  describe(): KitResponse {
    const state = this.readState();
    const items: KitItem[] = this.files().map((file) => {
      const own = this.ownText(file);
      const twin = this.userTwin(file);
      return {
        id: file.id,
        kind: file.kind,
        name: file.name,
        description: describe(own),
        origin: this.originOf(file),
        enabled: !state.disabled.includes(file.id),
        ...(twin
          ? {
              conflict: {
                userPath: twin,
                winner: state.winners[file.id] ?? 'user',
                same: sameText(own, readText(twin)),
              },
            }
          : {}),
      };
    });
    const taken = new Set(items.map((item) => `${item.kind}:${item.name}`));
    const globalOnly = globalItems(this.deps.claudeDir()).filter(
      (item) => !taken.has(`${item.kind}:${item.name}`),
    );
    const providers: KitProviderView[] = this.deps.providers().map(({ id, name }) => {
      const support = SUPPORT[id];
      return {
        id,
        title: name,
        mode: this.modeOf(id),
        modes: support?.modes ?? [],
        ...(support ? {} : { reason: 'no-run-layer' as const }),
        ...(support?.localOnly ? { localOnly: true } : {}),
        ...(support?.carries ? { carries: support.carries } : {}),
      };
    });
    return {
      version: this.version(),
      items,
      providers,
      mineDir: this.mineDir,
      builtinDir: this.builtin,
      globalDir: this.deps.claudeDir(),
      globalOnly,
    };
  }

  private originOf(file: KitFile): KitItem['origin'] {
    if (!existsSync(join(this.builtin, file.id))) return 'added';
    return existsSync(join(this.mineDir, file.id)) ? 'modified' : 'builtin';
  }

  private version(): string {
    try {
      const manifest = JSON.parse(
        readFileSync(join(this.builtin, '.claude-plugin', 'plugin.json'), 'utf8'),
      ) as { version?: string };
      return manifest.version ?? '';
    } catch {
      return '';
    }
  }

  read(id: string): KitItemContent {
    const file = this.fileById(id);
    const mine = join(this.mineDir, file.id);
    const twin = this.userTwin(file);
    const global = twin ? readText(twin) : null;
    const own = this.ownText(file);
    return {
      id: file.id,
      builtin: readText(join(this.builtin, file.id)),
      mine: existsSync(mine) ? readText(mine) : null,
      global,
      diff: global === null || tooBig(global, own) ? null : diffLines(global, own).lines,
    };
  }

  /** Правка ложится копией «моё»: встроенный файл обновится с версией панели и её не затрёт. */
  write(id: string, content: string): void {
    const file = this.fileById(id);
    // Кривой hooks.json сборка не разберёт — и каждый прогон в режиме набора
    // упал бы при сборке. Отказ здесь, пока человек ещё в редакторе.
    if (file.id === 'hooks/hooks.json' && !isHooksJson(content)) {
      throw new KitRefusal('kit-hooks-invalid');
    }
    const path = join(this.mineDir, file.id);
    mkdirSync(dirname(path), { recursive: true });
    writeTextFile(path, content);
  }

  /**
   * «Вернуть встроенный»: копия «моё» не удаляется, а уходит в архив набора —
   * правку, сделанную руками, можно достать.
   */
  reset(id: string): void {
    const file = this.fileById(id);
    // Навык уходит папкой: взятый из глобального слоя приносит соседние файлы, и
    // без них в «моё» остался бы обрывок, который сборка всё ещё подхватит.
    const rel = isTwinKind(file.kind) ? twinRoot(file.kind, file.name) : file.id;
    const path = join(this.mineDir, rel);
    if (!existsSync(path)) return;
    const archived = join(this.root, 'archive', `${Date.now()}`, rel);
    mkdirSync(dirname(archived), { recursive: true });
    renameSync(path, archived);
  }

  /**
   * «В глобальный»: элемент в том виде, в каком его получает прогон, ложится в
   * глобальный слой человека. Прежняя версия — в резервные копии панели (их
   * видно в «Истории изменений»). Возвращает путь копии, если она была.
   */
  exportToGlobal(id: string): string | undefined {
    const file = this.fileById(id);
    if (!isTwinKind(file.kind)) throw new KitRefusal('kit-global-unsupported');
    const backupDir = this.deps.backupDir ?? join(this.root, 'backups');
    return exportTwin(this.twinDirs(), backupDir, file.kind, file.name);
  }

  /** «Из глобального»: глобальная версия становится копией «моё» — поверх встроенного или новым элементом. */
  importFromGlobal(kind: KitTwinKind, name: string): void {
    // Имя — один сегмент пути: «.», «..» и разделители увели бы запись из каталога набора.
    if (!name || name.startsWith('.') || /[\\/]/.test(name)) {
      throw new KitRefusal('kit-global-missing');
    }
    if (!importTwin(this.twinDirs(), join(this.root, 'archive'), kind, name)) {
      throw new KitRefusal('kit-global-missing');
    }
  }

  setEnabled(id: string, enabled: boolean): void {
    this.fileById(id);
    const state = this.readState();
    const disabled = new Set(state.disabled);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    this.writeState({ ...state, disabled: [...disabled].sort() });
  }

  setWinner(id: string, winner: 'user' | 'kit'): void {
    this.fileById(id);
    const state = this.readState();
    this.writeState({ ...state, winners: { ...state.winners, [id]: winner } });
  }

  setMode(provider: string, mode: KitMode): void {
    if (!SUPPORT[provider]?.modes.includes(mode)) throw new KitRefusal('kit-mode-unsupported');
    const state = this.readState();
    this.writeState({ ...state, modes: { ...state.modes, [provider]: mode } });
  }

  /** Собранный каталог плагина под режим; `global` — набора нет. */
  composed(mode: Exclude<KitMode, 'global'>): string {
    const state = this.readState();
    const yielded =
      mode === 'hybrid'
        ? this.files()
            .filter((file) => this.userTwin(file) && (state.winners[file.id] ?? 'user') === 'user')
            .map((file) => file.id)
        : [];
    return composeKit({
      builtinDir: this.builtin,
      mineDir: this.mineDir,
      disabled: state.disabled,
      yielded,
      target: join(this.root, 'effective', mode, 'agentdeck-kit'),
    });
  }

  /**
   * Что добавить к прогону. Вызывается на КАЖДЫЙ старт: режим, сменённый на
   * странице, действует со следующего сообщения, без перезапуска панели.
   *
   * `local` — прогон идёт через контур локальной модели: правила получают
   * короткий блок дисциплины (`rules/local.md`), а Qwen Code — свой `QWEN_HOME`.
   * `hasSources` — флаг источников уже стоит от слоёв контура.
   */
  runExtras(input: { provider: string; local: boolean; hasSources: boolean }): {
    args: string[];
    env: Record<string, string>;
  } {
    const mode = this.modeOf(input.provider);
    if (mode === 'global') return { args: [], env: {} };
    if (input.provider === 'claude') {
      const args = ['--plugin-dir', this.composed(mode)];
      // «Только набор панели»: личный источник `user` снимается тем же флагом,
      // что и у слоёв контура; вход в аккаунт живёт не в настройках и остаётся.
      if (mode === 'ours' && !input.hasSources) args.push('--setting-sources', 'project,local');
      return { args, env: { [KIT_VARIANT_ENV]: input.local ? 'local' : 'standard' } };
    }
    if (input.provider === 'qwen' && mode === 'ours' && input.local) {
      const home = composeQwenHome(
        this.composed('ours'),
        join(this.root, 'qwen-home'),
        true,
        qwenVariantDir(),
      );
      return { args: [], env: { QWEN_HOME: home } };
    }
    if (input.provider === 'codex' && mode === 'hybrid') {
      // Весь набор («Наши»), а не уступки «оба набора» у Claude: одноимённые
      // навыки Claude лежат в ~/.claude, которого Codex не читает.
      const overlay = buildCodexOverlay({
        kitDir: this.composed('ours'),
        local: input.local,
        codexHome: this.deps.codexHome?.(),
      });
      const file = join(this.root, 'codex', `overlay-${input.local ? 'local' : 'standard'}.json`);
      return { args: [], env: { [CODEX_KIT_ENV]: writeCodexOverlay(file, overlay) } };
    }
    return { args: [], env: {} };
  }
}
