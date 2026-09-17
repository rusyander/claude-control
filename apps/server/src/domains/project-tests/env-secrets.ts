import type {
  ProjectTestEnvironment,
  ProjectTestSecretRef,
  ProjectTestSecretStatus,
} from '@agentdeck/contracts';
import { normalizeProjectPath } from '../../lib/app-store/projects.ts';
import {
  MAX_KEY_LENGTH,
  clearStoredKey,
  getStoredKey,
  setStoredKey,
} from '../../lib/provider-keys.ts';
import { ProjectTestsError } from './files.ts';
import { brandEnvName, legacyEnvName } from '../../lib/brand.mjs';

/**
 * Доступы стенда: логин, пароль, токен — то, без чего прогон упирается в форму
 * входа и проверяет только открытые страницы.
 *
 * РАЗДЕЛЕНИЕ ЖЁСТКОЕ. В файле проекта (`environments.json` — он в git и уезжает
 * к каждому, кто склонировал репозиторий) лежит ТОЛЬКО имя переменной. Значение
 * живёт в том же зашифрованном хранилище, что ключи провайдеров и токены
 * интеграций (`lib/provider-keys.ts`: AES-256-GCM, машинно-локальный ключевой
 * файл), под своим пространством имён `env:`. Второго хранилища секретов в
 * панели нет и заводить его незачем.
 *
 * Наружу значение не выходит НИКОГДА: ни в ответе API (только маска), ни в
 * задании агенту (там перечислены имена — этого хватает, чтобы он прочитал их
 * из своего окружения), ни в логе прогона (совпадения затираются, см.
 * `runs.ts`). Единственный путь наружу — переменные окружения процесса CLI,
 * ради которых всё и заводилось.
 *
 * Одно окружение — одна запись хранилища с картой «имя → значение». Так
 * удаление окружения стирает его доступы одним действием: перебирать ключи по
 * префиксу и надеяться, что ни один не остался, здесь было бы хуже.
 */

/** Имя переменной окружения: буквы, цифры, подчёркивание, не с цифры. */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Имена, которых панель не отдаёт под доступы стенда.
 *
 * Это не безопасность от злоумышленника — файл проекта правят руками, — а
 * защита от тихой подмены: `ANTHROPIC_API_KEY` из окружения стенда сменил бы
 * аккаунт, которым панель платит за прогон, а `PATH` сломал бы сам запуск CLI.
 * Оба случая выглядели бы как необъяснимая поломка прогона.
 */
const RESERVED = ['PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'NODE_OPTIONS', 'SHELL', 'TEMP', 'TMP'];
const RESERVED_PREFIXES = ['CLAUDE_', 'ANTHROPIC_', 'AWS_', brandEnvName(''), legacyEnvName('')];

/** Ключ окружения в общем хранилище секретов панели. */
export function environmentSecretsKey(root: string, environmentId: string): string {
  return `env:${normalizeProjectPath(root)}:${environmentId}`;
}

/** Имя переменной годится под доступ стенда — или отказ с причиной. */
export function assertSecretName(name: string): string {
  const clean = name.trim();
  if (!NAME_RE.test(clean)) {
    throw new ProjectTestsError(
      `«${clean}» не годится именем переменной: латиница, цифры и подчёркивание, не начиная с цифры.`,
    );
  }
  const upper = clean.toUpperCase();
  if (RESERVED.includes(upper) || RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
    throw new ProjectTestsError(
      `Переменная «${clean}» занята самой панелью: под ней уезжают доступ к аккаунту и запуск CLI. ` +
        'Назовите доступ стенда своим именем — например, STAND_PASSWORD.',
    );
  }
  return clean;
}

/** Все значения окружения. ТОЛЬКО для запуска прогона — наружу они не идут. */
export function readSecretValues(
  appDataDir: string,
  root: string,
  environmentId: string,
): Record<string, string> {
  const raw = getStoredKey(appDataDir, environmentSecretsKey(root, environmentId));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value) values[name] = value;
    }
    return values;
  } catch {
    // Битая запись — то же, что пустая: секретов не раскрываем, прогон не рушим.
    return {};
  }
}

/**
 * Записать или стереть одно значение. Пустое — это осознанное «выкинуть ключ»,
 * поэтому форма присылает поле только тогда, когда человек его тронул.
 */
export function writeSecretValue(
  appDataDir: string,
  root: string,
  environmentId: string,
  name: string,
  value: string,
): void {
  const key = assertSecretName(name);
  if (value.length > MAX_KEY_LENGTH) {
    throw new ProjectTestsError('Значение длиннее допустимого.');
  }
  const values = readSecretValues(appDataDir, root, environmentId);
  if (value) values[key] = value;
  else delete values[key];

  const storeKey = environmentSecretsKey(root, environmentId);
  if (Object.keys(values).length === 0) clearStoredKey(appDataDir, storeKey);
  else setStoredKey(appDataDir, storeKey, JSON.stringify(values));
}

/** Забыть все доступы окружения — вызывается, когда окружение удаляют. */
export function forgetEnvironmentSecrets(
  appDataDir: string,
  root: string,
  environmentId: string,
): void {
  clearStoredKey(appDataDir, environmentSecretsKey(root, environmentId));
}

/**
 * Что панель показывает про доступы окружения.
 *
 * Список ведёт ФАЙЛ: объявленное в проекте имя видно и на машине, где значения
 * нет, — иначе про недостающий доступ узнавали бы только по упавшему прогону.
 * Значение, оставшееся от удалённого объявления, тоже показывается: его надо
 * либо вернуть в файл, либо стереть, а молчание оставило бы секрет висеть.
 */
export function describeSecrets(
  appDataDir: string,
  root: string,
  environment: ProjectTestEnvironment,
): ProjectTestSecretStatus[] {
  const values = readSecretValues(appDataDir, root, environment.id);
  const declared = environment.secrets ?? [];
  const extra = Object.keys(values)
    .filter((name) => !declared.some((item) => item.name === name))
    .map((name): ProjectTestSecretRef => ({ name }));

  return [...declared, ...extra].map((ref) => {
    const value = values[ref.name] ?? '';
    return { ...ref, hasValue: Boolean(value), masked: secretMask(value) };
  });
}

/**
 * Маска доступа: «задан» и не больше того.
 *
 * Маска ключей провайдеров (`maskKey`) показывает первые три символа и
 * последние четыре — у ключа вида `sk-ant-…` это опознавательный знак, а не
 * секрет. У пароля стенда это семь символов из десяти, то есть подсказка тому,
 * кто заглянул через плечо. Здесь видно только длину и два последних символа —
 * этого хватает, чтобы отличить «вставил не то» от «вставил то».
 */
export function secretMask(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(value.length - 2, 12))}${value.slice(-2)}`;
}

/**
 * Затирание доступов во всём, что прогон отдаёт наружу.
 *
 * Панель не может запретить агенту повторить пароль в выводе — она может лишь
 * не показать его дальше. Замена буквальная (`split`/`join`, без регулярок:
 * пароль почти всегда содержит спецсимволы, и экранировать пришлось бы ровно
 * ради этого).
 *
 * Короче четырёх символов не трогаем: такое значение встречается в любом логе
 * само по себе, и «затирание» изуродовало бы текст, ничего не спрятав, — такой
 * секрет секретом и не был.
 */
export function redactor(values: Record<string, string>): ((text: string) => string) | undefined {
  const secrets = Object.values(values).filter((value) => value.length >= 4);
  if (secrets.length === 0) return undefined;
  return (text) => secrets.reduce((acc, secret) => acc.split(secret).join('•••'), text);
}

/** Что уедет в процесс прогона и чего не хватило. */
export interface RunSecrets {
  /** Переменные окружения для CLI. Пусто — прогон идёт без доступов. */
  values: Record<string, string>;
  /** Объявленные в проекте имена, значения которых на этой машине нет. */
  missing: ProjectTestSecretRef[];
}

/**
 * Доступы для запуска: значения по объявленным именам плюс список недостающих.
 *
 * Нехватка прогон НЕ отменяет. Половина набора обычно живёт без входа вовсе, и
 * отказ на старте («сначала введите пароль») запретил бы то, что раньше
 * работало. Вместо отказа — строка в логе с именем переменной: провал входа
 * станет объяснимым, а не загадочным.
 */
export function runSecrets(
  appDataDir: string,
  root: string,
  environment?: ProjectTestEnvironment,
): RunSecrets {
  if (!environment) return { values: {}, missing: [] };
  const stored = readSecretValues(appDataDir, root, environment.id);
  const declared = environment.secrets ?? [];
  const values: Record<string, string> = {};
  const missing: ProjectTestSecretRef[] = [];

  for (const ref of declared) {
    const value = stored[ref.name];
    if (value) values[ref.name] = value;
    else missing.push(ref);
  }
  return { values, missing };
}
