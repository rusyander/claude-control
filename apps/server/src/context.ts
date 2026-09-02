import { existsSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { AppSettings, ClaudeLocation } from '@claude-control/contracts';
import { detectClaudeLocation } from './lib/claude-paths.ts';
import {
  setBackupKeep,
  setEncryptSecretBackups,
  setSecretPassphrase,
  setSecretsBasename,
} from './lib/safe-io.ts';
import { AppStore } from './lib/app-store.ts';
import { stateFilePath } from './lib/app-store/state-file.ts';
import { PricingStore } from './domains/analytics/pricing-source.ts';
import { ModelCatalogStore } from './domains/models/model-store.ts';
import { FormatCheckStore } from './domains/format-check.ts';

/**
 * Общее состояние сервера: где лежит конфигурация Claude Code и хранилище
 * данных приложения. Каталог может смениться на лету — пользователь укажет
 * другой путь в настройках, — поэтому контекст умеет перестраиваться.
 */
export class ServerContext {
  location: ClaudeLocation;
  store: AppStore;
  /** Прайс Anthropic: кэш на диске рядом с состоянием приложения. */
  pricing: PricingStore;
  /** Каталог моделей провайдеров: кэш там же, рядом с прайсом. */
  models: ModelCatalogStore;
  /** Сверка форматов чужих CLI с их схемами: кэш там же. */
  formatCheck: FormatCheckStore;
  /**
   * Хранилище каталога, с которого сервер СТАРТУЕТ (без ручного пути). Только
   * его `state.json` читается при следующем запуске, поэтому ручной путь
   * запоминается именно здесь — а не в хранилище каталога, куда переехали:
   * оттуда его при старте никто не прочитает, и панель после перезапуска
   * молча оказывалась в домашнем каталоге.
   */
  private readonly bootStore: AppStore;
  /** Каталог данных `bootStore`: возврат туда переиспользует ЭТОТ экземпляр, а не заводит второй поверх того же файла. */
  private readonly bootAppData: string;

  constructor() {
    // На первом запуске настроек ещё нет, поэтому определяем путь без override,
    // затем перечитываем — вдруг в сохранённых настройках указан другой каталог.
    this.location = detectClaudeLocation();
    this.store = createStoreAt(this.location.paths.appData);
    this.bootStore = this.store;
    this.bootAppData = normalizePath(this.location.paths.appData);
    this.pricing = new PricingStore(this.location.paths.appData);
    this.models = new ModelCatalogStore(this.location.paths.appData);
    this.formatCheck = new FormatCheckStore(this.location.paths.appData);

    const override = this.bootStore.getSettings().claudeDirOverride;
    if (override) this.relocate(override);
    else this.applyIoSettings();
  }

  /**
   * Перечитать настройки, которые `safe-io` держит глобально на процесс:
   * глубину ротации копий, шифрование копий секретов и имя файла секретов.
   *
   * Зачем отдельным методом: у каждого каталога конфигурации СВОЙ `state.json`,
   * поэтому после смены каталога или импорта состояния прежние значения
   * становятся чужими. Хуже всего это выглядело на шифровании: новый каталог
   * говорит «копии секретов шифровать», а процесс продолжал писать их открытым
   * текстом, потому что флаг остался от предыдущего.
   */
  applyIoSettings(): void {
    const settings = this.store.getSettings();
    setBackupKeep(settings.backupKeep);
    setEncryptSecretBackups(settings.encryptSecretBackups);
    setSecretsBasename(basename(this.location.paths.secretsEnv));
  }

  /**
   * Запомнить ручной путь (пустая строка — вернуться к автоопределению) там,
   * откуда его прочитает следующий запуск. Само перемещение — `relocate`.
   */
  rememberDirOverride(value: string): void {
    this.bootStore.updateSettings({ claudeDirOverride: value });
  }

  /**
   * Настройки, как их видит клиент: всё из текущего хранилища, а ручной путь —
   * из хранилища старта, где он на самом деле живёт. Иначе после переезда
   * GET /api/settings показывал бы пустой `claudeDirOverride` рядом с
   * /api/location «задан вручную».
   */
  effectiveSettings(): AppSettings {
    return {
      ...this.store.getSettings(),
      claudeDirOverride: this.bootStore.getSettings().claudeDirOverride,
    };
  }

  /**
   * Смена каталога конфигурации. Возвращает результат обнаружения нового пути.
   *
   * Всё или ничего: хранилище нового каталога заводится ДО того, как контекст
   * его примет. Раньше `location` присваивался первым, и если `claude-control/`
   * в новом месте создать не удавалось (указан файл, нет прав), запрос падал
   * 500, а `/api/location` уже показывал новый путь при старом хранилище —
   * панель оставалась в разобранном состоянии до ручного сброса.
   */
  relocate(override: string): ClaudeLocation {
    const next = detectClaudeLocation(override);
    // Невалидный путь не применяем: иначе приложение потеряет доступ к данным
    // и пользователь останется без интерфейса, из которого это можно починить.
    if (!next.isValid) return next;

    const fresh = !existsSync(stateFilePath(next.paths.appData));
    let store: AppStore;
    try {
      // Обратно в каталог старта — тем же экземпляром: второй AppStore поверх
      // того же state.json расходился с первым в памяти (один уже запомнил
      // ручной путь, другой прочитал файл раньше), и GET /settings после
      // сброса ещё показывал прежний каталог.
      store =
        normalizePath(next.paths.appData) === this.bootAppData
          ? this.bootStore
          : createStoreAt(next.paths.appData);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ...next,
        isValid: false,
        problem: `Каталог данных панели в ${next.paths.root} не создаётся: ${detail}`,
      };
    }
    // Свежий каталог наследует политику удалённого доступа: иначе переезд молча
    // выключал гейт по токену, пока Tailscale Serve по-прежнему выводит панель наружу.
    if (fresh) store.updateSettings({ remoteAccess: this.store.getSettings().remoteAccess });

    this.location = next;
    this.store = store;
    // Кэш прайса лежит рядом с состоянием приложения, а оно у каждого каталога
    // своё — иначе панель показывала бы дату обновления из чужого каталога.
    this.pricing = new PricingStore(this.location.paths.appData);
    this.models = new ModelCatalogStore(this.location.paths.appData);
    this.formatCheck = new FormatCheckStore(this.location.paths.appData);
    this.applyIoSettings();
    // Парольная фраза относилась к секретам ПРЕЖНЕГО каталога — держать её в
    // памяти для чужого файла нельзя. Введут заново, когда понадобится.
    setSecretPassphrase(undefined);
    return next;
  }

  /** Каталог резервных копий — или undefined, если пользователь их отключил. */
  get backupDir(): string | undefined {
    return this.store.getSettings().backupBeforeWrite ? this.store.backupDir : undefined;
  }
}

function createStoreAt(appData: string): AppStore {
  mkdirSync(appData, { recursive: true });
  return new AppStore(appData);
}

/** Сравнение каталогов: на Windows регистр и слэши в пути — не разница. */
function normalizePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
