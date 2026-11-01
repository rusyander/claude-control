import type { ForgeKind } from '@agentdeck/contracts/core/forge';
import { gitConfigEnv } from '../../adapters/launcher/env.ts';
import { SESSION_MARKER } from './hooks.ts';

/**
 * Свой push публикатора (05 §Push closure, G5): копия закрыта для сеанса, публикатор открывает
 * её только для своего вызова.
 *
 * - Адрес — явный URL, никогда имя удалённого: `remote.<r>.pushurl` многозначен, и `-c` ДОБАВЛЯЕТ
 *   значение, а не заменяет — закрытый адрес копии всё равно пробовался бы.
 * - Хуки — репозитория (`-c core.hooksPath=<свой каталог репо>`): хуки проекта идут на push ядра
 *   (04 §Full stack), каталог ядра с отказом `pre-push` в цепочке не участвует.
 * - Учётные данные — парами `GIT_CONFIG_COUNT` в окружении, никогда в argv (argv видят `ps` и
 *   журнал процессов): `http.extraHeader` Basic по виду форджа. SSH — своя настройка человека.
 * - Метки сеанса в окружении нет: её видит `pre-push` ядра.
 */

export interface PublisherPushInput {
  /** Настоящий адрес push: общий `remote.<r>.pushurl`, иначе `remote.<r>.url`. */
  url: string;
  /** Каталог хуков репозитория, как его нашёл бы git без покопийного слоя ядра. */
  repoHooksPath: string;
  /** Доступ к форджу ядра; `null` — адрес не HTTP(S) или форж не настроен: своя настройка git. */
  credential: { kind: ForgeKind; token: string } | null;
  /** Окружение, поверх которого пойдёт git: пары конфига дописываются после уже заданных. */
  env?: Record<string, string>;
}

export interface PublisherPushSpec {
  url: string;
  /** Ключи git перед подкомандой — без секретов. */
  gitArgs: string[];
  /** Добавить к окружению git. */
  env: Record<string, string>;
  /** Убрать из окружения git (без учёта регистра на Windows — решает вызывающий). */
  dropEnv: string[];
}

/** Имя пользователя Basic для токена: GitLab принимает `oauth2`, GitHub — `x-access-token`. */
const BASIC_USER: Record<ForgeKind, string> = {
  gitlab: 'oauth2',
  github: 'x-access-token',
  generic: 'token',
};

const isHttp = (url: string): boolean => {
  const lower = url.toLowerCase();
  return lower.startsWith('https://') || lower.startsWith('http://');
};

export function publisherPushSpec(input: PublisherPushInput): PublisherPushSpec {
  const pairs: string[] = [];
  if (input.credential && isHttp(input.url)) {
    const basic = Buffer.from(
      `${BASIC_USER[input.credential.kind]}:${input.credential.token}`,
    ).toString('base64');
    // Пустой помощник снимает список помощников человека: окно менеджера учётных данных не
    // всплывает посреди публикации, доступ — только наш заголовок.
    pairs.push('-c', 'credential.helper=', '-c', `http.extraHeader=Authorization: Basic ${basic}`);
  }
  return {
    url: input.url,
    gitArgs: ['-c', `core.hooksPath=${input.repoHooksPath}`],
    env: {
      ...(pairs.length > 0 ? gitConfigEnv(input.env ?? {}, pairs) : {}),
      GIT_TERMINAL_PROMPT: '0',
    },
    // Только метка: `GIT_SSH_COMMAND` ядра — настройка человека (ключ, порт), обёртки сеанса
    // в окружении ядра нет — её кладёт лишь `composeEnv` сессии.
    dropEnv: [SESSION_MARKER],
  };
}
