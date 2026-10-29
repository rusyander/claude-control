import type { ServiceEndpoint, ServiceRecipe } from '@agentdeck/contracts/core/records';

/**
 * Рецепт → контейнер (04:124): окружение запуска, главный порт, адрес для копии, проба
 * готовности. Чистые функции. Пароль из рецепта попадает только в адрес копии (`rewriteEnv`),
 * не в журнал: в записи ресурса — порт и рецепт, адрес собирается заново (04:91).
 */

const DEFAULT_PORT: Record<string, number> = {
  postgres: 5432,
  mysql: 3306,
  mongodb: 27017,
  redis: 6379,
  amqp: 5672,
  kafka: 9092,
};

/** Главный порт: первый порт рецепта, иначе порт схемы по умолчанию. */
export function mainPort(recipe: ServiceRecipe): number | null {
  if (recipe.ports.length > 0) return recipe.ports[0] as number;
  return recipe.scheme ? (DEFAULT_PORT[recipe.scheme] ?? null) : null;
}

/** Порты для публикации (главный — первым). */
export function publishPorts(recipe: ServiceRecipe): number[] {
  const main = mainPort(recipe);
  return [...new Set([...(main === null ? [] : [main]), ...recipe.ports])];
}

/**
 * Окружение контейнера: рецепт как есть + вход без пароля, когда рецепт пароля не задал —
 * контейнер одноразовый и слушает только 127.0.0.1, а без пароля образ Postgres/MySQL не стартует.
 */
export function containerEnv(recipe: ServiceRecipe): Record<string, string> {
  const env = { ...recipe.env };
  if (recipe.scheme === 'postgres' && !env.POSTGRES_PASSWORD && !env.POSTGRES_HOST_AUTH_METHOD)
    env.POSTGRES_HOST_AUTH_METHOD = 'trust';
  if (
    recipe.scheme === 'mysql' &&
    !env.MYSQL_ROOT_PASSWORD &&
    !env.MYSQL_ALLOW_EMPTY_PASSWORD &&
    !env.MYSQL_RANDOM_ROOT_PASSWORD
  )
    env.MYSQL_ALLOW_EMPTY_PASSWORD = 'yes';
  return env;
}

function auth(user: string, password: string | undefined): string {
  const u = encodeURIComponent(user);
  return password ? `${u}:${encodeURIComponent(password)}@` : `${u}@`;
}

/** Адрес сервиса для окружения копии (04:93); схема неизвестна — адреса нет. */
export function endpointOf(recipe: ServiceRecipe, hostPort: number): ServiceEndpoint | null {
  const env = recipe.env;
  const at = `127.0.0.1:${hostPort}`;
  switch (recipe.scheme) {
    case 'postgres': {
      const user = env.POSTGRES_USER ?? 'postgres';
      const db = env.POSTGRES_DB ?? user;
      return {
        recipe: recipe.name,
        url: `postgres://${auth(user, env.POSTGRES_PASSWORD)}${at}/${db}`,
      };
    }
    case 'mysql': {
      const user = env.MYSQL_USER ?? 'root';
      const password = env.MYSQL_USER ? env.MYSQL_PASSWORD : env.MYSQL_ROOT_PASSWORD;
      const db = env.MYSQL_DATABASE ?? '';
      return { recipe: recipe.name, url: `mysql://${auth(user, password)}${at}/${db}` };
    }
    case 'mongodb':
      return { recipe: recipe.name, url: `mongodb://${at}` };
    case 'redis':
      return { recipe: recipe.name, url: `redis://${at}` };
    case 'amqp': {
      const user = env.RABBITMQ_DEFAULT_USER ?? 'guest';
      const password = env.RABBITMQ_DEFAULT_PASS ?? 'guest';
      return { recipe: recipe.name, url: `amqp://${auth(user, password)}${at}` };
    }
    case 'kafka':
      return { recipe: recipe.name, url: `kafka://${at}` };
    default:
      return null;
  }
}

/**
 * Проба готовности внутри контейнера: TCP-порт открыт раньше, чем сервис принимает запросы
 * (Postgres во время init слушает только сокет, MySQL — временный сервер). `null` — только TCP.
 */
export function readinessArgv(recipe: ServiceRecipe): string[] | null {
  const env = recipe.env;
  switch (recipe.scheme) {
    case 'postgres':
      return ['pg_isready', '-h', '127.0.0.1', '-U', env.POSTGRES_USER ?? 'postgres'];
    case 'mysql':
      return ['mysqladmin', 'ping', '-h', '127.0.0.1', '--silent'];
    case 'redis':
      return ['redis-cli', 'ping'];
    default:
      return null;
  }
}
