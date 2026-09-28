import type { CopyWarning, Group, MemberAdvice } from '@agentdeck/contracts';

/**
 * Группа так, как её отдаёт `GET /api/groups`: запись state.json плюс то, что
 * сервер досчитывает при чтении и не хранит.
 */
export interface GroupListItem extends Group {
  /**
   * Файлы участников, чей хэш ушёл от `origin.hash` — оригинал в проекте с тех
   * пор правили. Есть только у глобальной копии проектной группы.
   */
  originChanged?: string[];
  /** Проекты, чьи привязки, выбор или файлы ссылаются на группу. */
  usedIn?: string[];
  /**
   * Файл переопределения по проектам, если сервер его сообщает: включён ли и
   * где лежит. Нет поля — состояние неизвестно, карточка берёт его из ответа
   * переключателя.
   */
  overrides?: GroupOverrideState[];
}

export interface GroupOverrideState {
  path: string;
  enabled: boolean;
  file?: string;
}

/** Ответ копии в общие и слияния: новая (или обновлённая) группа и советы по участникам. */
export interface GroupAdviceResult {
  group: Group;
  advice: MemberAdvice[];
  /** Модель не ответила — `advice` пуст не потому, что советовать нечего. Только у копии. */
  adviceFailed?: true;
  /** Что копия не перенесла как есть (имя занято, вид не переносится). У слияния нет. */
  warnings?: CopyWarning[];
}

/** Ответ переключателя переопределения. */
export interface GroupOverrideResult {
  enabled: boolean;
  file: string;
}
