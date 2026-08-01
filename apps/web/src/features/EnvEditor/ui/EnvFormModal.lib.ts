import type { EnvSource, EnvVar, EnvVarDraft } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';

/** Похоже ли имя на секрет — по нему решаем, куда класть и маскировать ли. */
export const looksSecret = (name: string): boolean => /(TOKEN|SECRET|KEY|PASSWORD|PAT)/i.test(name);

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

  // Пустым полем очищают только то, что показали открытым текстом.
  if (!envVar?.isSecret || fields.value !== '') return draft;

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
    throw new Error(`Не удалось прочитать сохранённое значение ${envVar.key}`);
  }

  return { ...draft, value: data };
}
