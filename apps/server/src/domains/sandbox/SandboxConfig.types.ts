import type { CredentialsSource } from '../../lib/credentials.ts';

/** Что именно проверяем. */
export interface SandboxSelection {
  ruleIds?: string[];
  skillIds?: string[];
  hookIds?: string[];
  mcpIds?: string[];
  /** Файлы скриптов из hooks/, которые нужны выбранным хукам. */
  scriptNames?: string[];
  /** Текст правила, которого ещё нет в настройках, — для проверки черновика. */
  draftRule?: { title: string; text: string };
}

export interface SandboxDescription {
  /** Что попало в песочницу — показывается пользователю перед прогоном. */
  rules: string[];
  skills: string[];
  hooks: string[];
  mcpServers: string[];
  scripts: string[];
}

export interface Sandbox {
  id: string;
  configDir: string;
  workDir: string;
  description: SandboxDescription;
  /**
   * Откуда взялся токен и почему не взялся. Нужно интерфейсу: без токена
   * разговор в песочнице не пойдёт, и причину лучше назвать заранее.
   */
  credentials: { source: CredentialsSource; reason?: string };
  /** Переменные окружения для запуска: сюда попадает ключ API, если доступ им. */
  env: Record<string, string>;
}

/** Песочница, которую не удалось убрать: внутри осталась копия доступа. */
export interface SweepFailure {
  id: string;
  path: string;
  error: string;
}

export interface SweepReport {
  removed: string[];
  failed: SweepFailure[];
}

/**
 * Куда уходит жалоба подметания.
 *
 * Молчаливый отказ здесь — та же беда, что и молчаливое удаление: на диске
 * осталась копия доступа к аккаунту, а узнать об этом неоткуда. Панель о
 * фоновом подметании не спрашивает, поэтому единственное место, где человек
 * это увидит, — поток ошибок сервера; в тестах сюда подставляется свой сток.
 */
export type SweepReporter = (line: string) => void;
