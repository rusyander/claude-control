/**
 * Общая ошибка «имя переменной непредставимо в формате провайдера».
 *
 * Живёт отдельным модулем, потому что её бросают РАЗНЫЕ адаптеры env
 * (`aider-yaml.ts` — строки `КЛЮЧ=значение` в YAML-списке, `dotenv-file.ts` —
 * строки `КЛЮЧ=значение` в `.env`), а маршрут `/api/provider-env` ловит её одним
 * `instanceof` и отвечает 400. Если бы класс лежал в одном из адаптеров, второй
 * импортировал бы его «вбок» — и `instanceof` держался бы на случайности.
 */
export class EnvKeyNotEncodableError extends Error {
  constructor(key: string, fileHint: string, rule: string) {
    super(`Имя переменной «${key}» нельзя записать в ${fileHint}: ${rule}`);
    this.name = 'EnvKeyNotEncodableError';
  }
}
