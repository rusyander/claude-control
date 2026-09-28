import type { EnvSource, EnvVar, EnvVarDraft } from '@agentdeck/contracts';
import { isSecretEnvKey } from '@agentdeck/contracts/env-secret';
import { apiClient } from '@shared/api/client';

/**
 * Похоже ли имя на секрет — по нему форма решает, куда класть и маскировать ли.
 * Правило ОДНО с сервером (contracts/env-secret): пока форма держала свою копию,
 * списки слов расходились — CREDENTIAL знал только сервер, и такая переменная
 * уезжала в settings.json открытым текстом, а в списке показывалась под маской.
 */
export const looksSecret = isSecretEnvKey;

const ENV_FILE_NAMES: Partial<Record<EnvSource, string>> = {
  settings: 'settings.json',
  'settings-local': 'settings.local.json',
  secrets: '.mcp-secrets.env',
};

/** Имя файла за источником — то, что человек видит в бейдже и в форме, а не слово из enum. */
export const envFileName = (source: EnvSource): string => ENV_FILE_NAMES[source] ?? source;

/**
 * Сохранённое значение секрета не дочиталось. Ключом, а не готовой фразой: текст
 * причины переводит форма, иначе английский интерфейс получал русскую строку.
 */
export class SecretRevealError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`Не удалось прочитать сохранённое значение ${key}`);
    this.key = key;
    this.name = 'SecretRevealError';
  }
}

/**
 * Тело запроса на сохранение. Вынесено из компонента, потому что здесь лежит
 * ловушка: у секрета поле значения открывается пустым (полное значение
 * браузеру не отдают), а подсказка обещает, что пустое поле оставит старое
 * значение. Сервер такого договора не знает — saveEnvVar пишет `KEY=` поверх
 * строки, и токен исчезает без единой ошибки. Поэтому пустое поле у секрета
 * означает «дочитать сохранённое», а не «сохранить пустоту».
 */
export async function buildEnvDraft(
  fields: { key: string; value: string; source: EnvSource; comment: string },
  envVar?: EnvVar,
): Promise<EnvVarDraft> {
  const key = fields.key.trim();
  const draft: EnvVarDraft = {
    key,
    value: fields.value,
    source: fields.source,
    isSecret: looksSecret(key),
    // Строкой, а не `|| undefined`: сервер отличает «поля не присылали» (тогда
    // комментарий в файле остаётся, так шлёт массовое добавление) от «прислали
    // пустое» (пользователь стёр текст — комментарий убрать). С `undefined`
    // очистка молча ничего не делала бы, а форма рапортовала бы «сохранено».
    comment: fields.comment.trim(),
  };

  // Пустым полем очищают только то, что показали открытым текстом. Секрет без
  // значения (его завёл агент, ввести должен человек) дочитывать нечего: сервер
  // отдал бы пустоту, и форма падала бы «не удалось прочитать» (ревью 28.09, F-224).
  if (!envVar?.isSecret || envVar.value === '' || fields.value !== '') return draft;

  const { data } = await apiClient.get<string>('/env/reveal', {
    // Ключ и источник берём у исходной переменной: её могли переименовать
    // или переложить в другой файл прямо в этой форме.
    params: { key: envVar.key, source: envVar.source },
    // Ответ забираем сырым текстом. Обычный разбор axios пробует JSON.parse на
    // любом теле: чисто числовой секрет («12345») приезжал бы числом, а секрет
    // вида `{"a":1}` — объектом, и проверка ниже отвергала бы законное значение.
    transformResponse: [(raw: unknown) => raw],
  });

  // Не дочитали — не сохраняем: пустое значение уехало бы в файл и молча,
  // «успешно», затёрло секрет.
  if (typeof data !== 'string' || data === '') {
    throw new SecretRevealError(envVar.key);
  }

  return { ...draft, value: data };
}

/**
 * Подсказки поля значения секрета (ключи i18n). Пустой секрет — его сохранил
 * агент панели и открыл форму, чтобы значение ввёл человек: «значение скрыто»
 * и «оставьте пустым» говорили бы, что оно уже есть, и форму закрывали бы ни с чем.
 */
export function secretValueHints(
  envVar: EnvVar | undefined,
): { placeholder: string; hint: string } | undefined {
  if (!envVar?.isSecret) return undefined;
  return envVar.value === ''
    ? { placeholder: 'env.secretEmpty', hint: 'env.secretEmptyHint' }
    : { placeholder: 'env.secretHidden', hint: 'env.secretRewrite' };
}
