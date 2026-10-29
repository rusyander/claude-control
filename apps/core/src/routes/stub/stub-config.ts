import type { StepLike } from '@agentdeck/stub-model';

/**
 * Общие данные маршрута-заглушки и его процесса-сервера: формат настройки и путь личности.
 * Отдельный модуль — чтобы процесс сервера не тянул маршрут, а маршрут не тянул сервер.
 */

/**
 * Сценарий, который можно передать в другой процесс: шаги-данные или модуль с экспортом.
 * `args` есть — экспорт фабрика, её зовут с этими данными (`scriptFor(task)`); нет — экспорт
 * сам сценарий (массив шагов или функция шага).
 */
export type StubScriptSource =
  StepLike[] | { module: string; export: string; args?: readonly unknown[] };

export interface StubServerConfig {
  port: number;
  /** rid ресурса `stub-server`: им сервер отвечает на путь личности. */
  owner: string;
  models: string[];
  script: StubScriptSource;
  trace?: string;
}

/**
 * Настройка уходит аргументом, а не окружением: запуск через WMI (Windows, выход из задания
 * ядра) отдаёт процессу окружение службы, а не переданное. base64url — без кавычек и пробелов,
 * которые пришлось бы экранировать в командной строке.
 */
export function encodeStubConfig(config: StubServerConfig): string {
  return Buffer.from(JSON.stringify(config), 'utf8').toString('base64url');
}

export function decodeStubConfig(arg: string | undefined): StubServerConfig {
  if (!arg) throw new Error('stub server: no config argument');
  return JSON.parse(Buffer.from(arg, 'base64url').toString('utf8')) as StubServerConfig;
}

export const STUB_IDENTITY_PATH = '/__agentdeck/stub-route';
