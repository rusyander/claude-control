import type { Fact } from '@agentdeck/contracts/core/facts';
import type { CheckKey, CheckRegistry, KeyParts, TreeRow } from '@agentdeck/contracts/core/records';

/** Всё, из чего считается ключ единицы (D§3.3); чтения уже сделаны — `keyOf` чистый. */
export interface KeyContext {
  registry: CheckRegistry;
  /** Строки дерева, о котором вопрос: рабочая копия или уходящий коммит. */
  rows: Fact<TreeRow[]>;
  /** Дерево базы на сервере (G2) — нужно только проверке, зависящей от базы. */
  baseRows: Fact<TreeRow[]> | null;
  /** Узкая выборка (тесты/файлы); `[]` — вся единица. Узкая запись не совпадает с записью единицы. */
  selection: string[];
  /** `путь → digest | absent` входов вне git (`platform/git` `inputDigests`). */
  inputs: Fact<Record<string, string>>;
  /** Имя инструмента → разрешённая версия (закреплённый профиль задачи). */
  tools: Record<string, string>;
  /** Окружение запуска; в ключ идут только имена `envAllow` записи. */
  env: Record<string, string | undefined>;
  /** Ключевой хеш значения (HMAC ключом дома ядра): значения в ключе и записи не хранятся (04:91). */
  envDigest: (value: string) => string;
}

export interface KeyOf {
  key: CheckKey;
  parts: KeyParts;
}
