import type { SubscriptionDriftResolution } from '@agentdeck/contracts/portable-subscribe';

// Транспорт: чистые функции, ничего не знающие про React.

/**
 * Уровень, на котором открыт экран: дом или проект.
 *
 * Едет ВО ВСЕ четыре запроса и во все ключи кэша. Молчаливого умолчания здесь
 * нет намеренно: уровень выбирает человек, и «по умолчанию дом» после
 * переключения на проект показал бы ему домашний паспорт из кэша под заголовком
 * проекта.
 */
export interface PortabilityLevel {
  scope: 'global' | 'project';
  /** Идентификатор проекта из реестра панели; пуст на глобальном уровне. */
  project?: string;
}

/** Пара «источник → цель» на одном уровне: всё, чем три шага переноса отличаются. */
export interface TransferPair extends PortabilityLevel {
  provider: string;
  target: string;
}

// Подписка: канон — источник, чужой CLI — его проекция (П5.1, П5.2).
//
// Источник НИ В ОДИН из шести запросов не передаётся. Канон подписки —
// собственная среда панели, и добавить сюда выбранный на экране источник
// значило бы сделать подписку вторым переносом, у которого истин столько же,
// сколько CLI на машине.

/** Адрес подписки: цель на уровне. Больше ничем две подписки не отличаются. */
export interface SubscriptionAddress extends PortabilityLevel {
  target: string;
}

/** Адрес исхода: подписка плюс файл и то, что с ним решили сделать (П5.2). */
export interface DriftAddress extends SubscriptionAddress {
  filePath: string;
  resolution: SubscriptionDriftResolution;
}
