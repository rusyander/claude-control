/**
 * Имя записи доступов стенда в общем зашифрованном хранилище (`provider-keys.ts`). Один источник
 * на панель (пишет доступы из «Тестов») и ядро (проход по стенду, этап 12, читает их для входа):
 * разойдись имена — ядро молча не нашло бы логин и шло бы по стенду без входа.
 *
 * Корень проекта нормализуется так же, как список проектов сервера (`normalizeProjectPath`):
 * слэши и черта в конце не различаются, регистр — только у путей Windows (буква диска или UNC).
 * Копия правила, а не импорт: пакет не тянет код сервера; совпадение держит тест сервера.
 */
export const ENVIRONMENT_KEY_PREFIX = 'env:';

/** Путь Windows — с буквой диска или UNC: только там регистр не различает папки. */
const WINDOWS_PATH = /^[A-Za-z]:([\\/]|$)|^\\\\/;

function normalizeRoot(path: string): string {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return WINDOWS_PATH.test(path) ? unified.toLowerCase() : unified;
}

/** Ключ окружения стенда `environmentId` проекта `root`. */
export function environmentSecretsKey(root: string, environmentId: string): string {
  return `${ENVIRONMENT_KEY_PREFIX}${normalizeRoot(root)}:${environmentId}`;
}
