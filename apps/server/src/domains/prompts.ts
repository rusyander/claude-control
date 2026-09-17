import type {
  PromptId,
  PromptOverride,
  PromptRecord,
  PromptSummary,
} from '@agentdeck/contracts/prompts';
import { builtinPromptSha, builtinPromptText, promptEntry, promptIds } from './prompts/catalog.ts';
import { clearOverride, readOverride, readOverrides, writeOverride } from './prompts/store.ts';

/**
 * Каталог промптов приложения — ОДНА дверь ко всем текстам, которыми панель
 * разговаривает с моделью не от имени человека.
 *
 * Правило, ради которого раздел вообще существует: текст промпта не живёт больше
 * нигде. Прослойка инструментов, режим картинки и режим презентации берут его
 * здесь по идентификатору (`promptText`), а не держат свою копию — иначе правка
 * человека в панели меняла бы половину поведения, а вторая половина продолжала бы
 * работать текстом из кода, и объяснить это было бы нечем. Сторож —
 * `prompts.one-reader.test.ts`: он краснеет, если строка встроенного текста
 * появилась в исходниках где-то ещё.
 *
 * Слоёв ровно два (репозиторий → правка человека), и оба видны в карточке:
 * `text` — то, чем панель работает, `builtinText` — то, к чему вернёт «Сбросить».
 */

export { promptsDir } from './prompts/store.ts';

/**
 * Текст, которым работает панель. Единственная функция, которую зовут режимы:
 * есть правка человека — она, нет — встроенный текст репозитория.
 */
export function promptText(appData: string, id: PromptId): string {
  return readOverride(appData, id)?.text ?? builtinPromptText(id);
}

/** Карточка одного промпта: оба текста и состояние правки. */
export function readPromptRecord(appData: string, id: PromptId): PromptRecord {
  const builtin = builtinPromptText(id);
  const override = readOverride(appData, id);
  return {
    id,
    version: promptEntry(id).version,
    text: override?.text ?? builtin,
    builtinText: builtin,
    overridden: Boolean(override),
    builtinChanged: builtinChanged(id, override?.baseSha),
    ...(override?.updatedAt ? { updatedAt: override.updatedAt } : {}),
  };
}

/** Список для экрана: без текстов, только размер и состояние. */
export function listPrompts(appData: string): PromptSummary[] {
  return promptIds().map((id) => {
    const override = readOverride(appData, id);
    const text = override?.text ?? builtinPromptText(id);
    return {
      id,
      version: promptEntry(id).version,
      overridden: Boolean(override),
      builtinChanged: builtinChanged(id, override?.baseSha),
      bytes: Buffer.byteLength(text, 'utf8'),
      ...(override?.updatedAt ? { updatedAt: override.updatedAt } : {}),
    };
  });
}

/**
 * Сохранить правку и вернуть карточку в новом состоянии.
 *
 * `backupDir` — каталог копий панели: страницу набранного текста перезаписывает
 * одно нажатие, истории правок у промптов нет («сохраняется последняя»), и
 * копия перед записью — единственное, что отличает правку от потери. Не задан
 * (человек выключил копии в настройках) — пишем без копии, как и все остальные
 * писатели панели.
 */
export function savePrompt(
  appData: string,
  id: PromptId,
  text: string,
  at?: string,
  backupDir?: string,
): PromptRecord {
  writeOverride(appData, id, text, at, backupDir);
  return readPromptRecord(appData, id);
}

/** «Сбросить к встроенному»: правка стирается, работает текст репозитория. */
export function resetPrompt(appData: string, id: PromptId, backupDir?: string): PromptRecord {
  clearOverride(appData, id, backupDir);
  return readPromptRecord(appData, id);
}

/** Правки этой машины — секция архива переноса. */
export function exportPromptOverrides(appData: string): PromptOverride[] {
  return readOverrides(appData);
}

/**
 * Встроенный текст переписан ПОСЛЕ того, как человек сохранил свой.
 *
 * Пустая база — правка, у которой отметки нет (файл пережил `index.json`): о
 * таком панель не утверждает ничего, потому что сравнивать не с чем. Утверждение
 * «встроенный изменился» без основания хуже молчания: человек пойдёт перечитывать
 * текст, который никто не трогал.
 */
function builtinChanged(id: PromptId, baseSha: string | undefined): boolean {
  return Boolean(baseSha) && baseSha !== builtinPromptSha(id);
}
