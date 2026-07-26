import { mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import type { ClaudeLocation } from '@claude-control/contracts';
import { detectClaudeLocation } from './lib/claude-paths.ts';
import {
  setBackupKeep,
  setEncryptSecretBackups,
  setSecretPassphrase,
  setSecretsBasename,
} from './lib/safe-io.ts';
import { AppStore } from './lib/app-store.ts';
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

  constructor() {
    // На первом запуске настроек ещё нет, поэтому определяем путь без override,
    // затем перечитываем — вдруг в сохранённых настройках указан другой каталог.
    this.location = detectClaudeLocation();
    this.store = this.createStore();
    this.pricing = new PricingStore(this.location.paths.appData);
    this.models = new ModelCatalogStore(this.location.paths.appData);
    this.formatCheck = new FormatCheckStore(this.location.paths.appData);

    const override = this.store.getSettings().claudeDirOverride;
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

  private createStore(): AppStore {
    mkdirSync(this.location.paths.appData, { recursive: true });
    return new AppStore(this.location.paths.appData);
  }

  /** Смена каталога конфигурации. Возвращает результат обнаружения нового пути. */
  relocate(override: string): ClaudeLocation {
    const next = detectClaudeLocation(override);
    // Невалидный путь не применяем: иначе приложение потеряет доступ к данным
    // и пользователь останется без интерфейса, из которого это можно починить.
    if (!next.isValid) return next;

    this.location = next;
    this.store = this.createStore();
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
