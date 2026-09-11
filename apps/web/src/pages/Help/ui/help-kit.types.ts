import type { ReactNode } from 'react';
import type { BadgeTone } from '@shared/ui/badge';
import type { IconName } from '@shared/ui/icon';

export interface HelpSectionProps {
  title: string;
  /** Одна фраза под заголовком: зачем читать этот блок. */
  caption?: string;
  /** Не у каждой секции есть содержимое: иногда хватает заголовка и фразы. */
  children?: ReactNode;
}

export interface StorageRow {
  /** Что это за строка: «Файл», «Формат», «Когда читается». */
  label: string;
  value: string;
  /** Пути, ключи конфига и адреса эндпоинтов набираются моноширинным. */
  isMono?: boolean;
}

export interface StorageCardProps {
  title: string;
  rows: StorageRow[];
}

export interface FieldRow {
  /** Настоящее имя поля из контракта — по нему поле ищется в коде. */
  name: string;
  description: string;
  /**
   * Моноширинный шрифт имени. По умолчанию да: в таблице обычно имена полей
   * из схемы. Выключается там, где в первой колонке человеческие названия —
   * возможности композера, вкладки, виды уведомлений.
   */
  isMono?: boolean;
  /** Пометка справа от имени: «обязательное», «может остановить действие». */
  badge?: string;
  badgeTone?: BadgeTone;
  /** Вторая пометка. Нужна событиям хуков: там их две независимых. */
  badge2?: string;
  badge2Tone?: BadgeTone;
}

export interface FieldTableProps {
  rows: FieldRow[];
  /** Заголовки колонок — переводятся вместе с остальным интерфейсом. */
  nameHeader: string;
  descriptionHeader: string;
  /**
   * Подпись над таблицей. Не задаётся, когда секция уже всё объяснила своей
   * подписью: два одинаковых предложения подряд читаются как ошибка вёрстки.
   */
  caption?: string;
}

export interface HelpStep {
  /** Что сделать на этом шаге. */
  title: string;
  /** Уточнение: куда нажать, что ввести, чего ожидать. */
  text?: string;
}

export interface StepListProps {
  steps: HelpStep[];
}

export type CalloutTone = 'info' | 'warning' | 'danger' | 'success';

export interface CalloutProps {
  tone?: CalloutTone;
  title: string;
  /** Пояснение под заголовком. Короткая заметка обходится одним заголовком. */
  children?: ReactNode;
}

export interface OptionCard {
  title: string;
  text: string;
  /** Пометка над заголовком: «только при создании», «по умолчанию». */
  badge?: string;
  badgeTone?: BadgeTone;
}

export interface OptionCardsProps {
  items: OptionCard[];
  /** Минимальная ширина карточки: у длинных описаний она больше. */
  minWidth?: number;
}

export interface CapabilityGridProps {
  canTitle: string;
  can: string[];
  cantTitle: string;
  cant: string[];
}

export interface TopicNavProps {
  /** Предыдущий и следующий разделы справки — оба могут отсутствовать. */
  prev?: { id: string; title: string };
  next?: { id: string; title: string };
  prevLabel: string;
  nextLabel: string;
}

/** Чья это сторона на снимке: подпись говорит это первым словом. */
export type HelpShotSide = 'enterprise-platform' | 'panel';

export interface HelpShotProps {
  /** Раздел справки — он же папка каталога и первая часть ключа подписи. */
  topic: string;
  /** Один путь через раздел от начала до конца: `connect`, `split`, `run`. */
  scenario: string;
  /** Кадр: `NN-слаг`, имя файла без расширения и последняя часть ключа. */
  frame: string;
  side: HelpShotSide;
}

export interface HelpDiagramProps {
  /** Раздел справки — папка каталога и первая часть ключа подписи. */
  topic: string;
  /** Имя схемы: файл `<name>.png` и последняя часть ключа подписи. */
  name: string;
}

export interface GuideStepsProps {
  children: ReactNode;
}

export interface GuideStepProps {
  /** Что делается на шаге. Номер подставляет счётчик, в заголовке его нет. */
  title: string;
  /** Подробность: куда нажать, что ввести, что означает увиденное. */
  text?: string;
  /** Снимки шага и тонкости к нему. */
  children?: ReactNode;
}

export interface TopicCardProps {
  title: string;
  /** Одна строка о разделе: чем он занимается. */
  summary: string;
  icon: IconName;
  /** Куда ведёт карточка: /help?topic=<id>. */
  topicId: string;
}
