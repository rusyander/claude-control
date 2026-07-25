import { mkdirSync } from 'node:fs';
import type { ClaudeLocation } from '@claude-control/contracts';
import { detectClaudeLocation } from './lib/claude-paths.ts';
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
    return next;
  }

  /** Каталог резервных копий — или undefined, если пользователь их отключил. */
  get backupDir(): string | undefined {
    return this.store.getSettings().backupBeforeWrite ? this.store.backupDir : undefined;
  }
}
