import type { TFunction } from 'i18next';
import {
  AGENT_MIN_CONTEXT,
  isLowQuality,
  type CatalogModel,
  type ChoiceOption,
} from '@agentdeck/contracts/local-models';
import { toGb } from '@entities/LocalModels';

/** Число с одной цифрой после запятой по правилам языка: «26,1» в русском, «26.1» в английском. */
export function formatGb(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
    Math.round(value * 10) / 10,
  );
}

/** Окно подписью: 8K … 256K, предел в миллион — «1M». */
export function contextLabel(value: number): string {
  return value >= 1_048_576 && value % 1_048_576 === 0
    ? `${value / 1_048_576}M`
    : `${Math.round(value / 1024)}K`;
}

/** Причина закрытого варианта — «не влезет: нужно 26,1 ГБ из 24». */
export function blockText(
  option: ChoiceOption<string | number>,
  t: TFunction,
  locale: string,
): string | undefined {
  if (option.block === 'agent-min')
    return t('localModels.catalog.selects.agentMin', { min: AGENT_MIN_CONTEXT / 1024 });
  if (option.block === 'too-big')
    return t('localModels.catalog.selects.noFit', {
      need: formatGb(option.needGb, locale),
      available: formatGb(option.availableGb, locale),
    });
  return undefined;
}

/**
 * Как квантование называется для человека: настоящее из файла, а у файла из Ollama, чьё
 * квантование не определилось, — «неизвестное квантование». Служебное слово «Ollama» — никогда.
 */
export function quantTitle(model: CatalogModel, id: string, t: TFunction): string {
  const quant = model.quants.find((item) => item.id === id);
  if (quant?.label) return quant.label;
  return quant?.source === 'ollama' ? t('localModels.catalog.selects.unknownQuant') : id;
}

/**
 * Вариант списка квантования: метка, размер файла, «скачано» и — у закрытого —
 * причина с цифрами (у выбранного — без неё, она под списками). Причина в тексте варианта, а не в подсказке: нативный
 * список показывает только его, и скринридер читает его же.
 */
export function quantOptionText(
  option: ChoiceOption<string>,
  installed: boolean,
  t: TFunction,
  locale: string,
  current = false,
  recommended = false,
): string {
  const parts = [
    t('localModels.catalog.selects.quantOption', {
      // Служебная метка («Ollama») человеку не показывается: настоящее квантование из заголовка файла.
      id:
        option.label ??
        (option.source === 'ollama' ? t('localModels.catalog.selects.unknownQuant') : option.value),
      size: formatGb(toGb(option.sizeBytes ?? 0), locale),
    }),
  ];
  // «Перенесён из Ollama» заменяет «скачано»: файл есть на диске, и откуда он — важнее.
  if (option.source === 'ollama') {
    if (!current) parts.push(t('localModels.catalog.selects.fromOllama'));
  } else if (installed) parts.push(t('localModels.catalog.selects.installedMark'));
  // У выбранного в поле — только короткая подпись: причина встанет под списками одной строкой,
  // иначе длинный текст не влезает в поле на узком экране.
  if (current) return parts.join(' · ');
  if (recommended) parts.push(t('localModels.catalog.selects.recommended'));
  if (isLowQuality(option.label ?? option.value))
    parts.push(t('localModels.catalog.selects.lowQuality'));
  const blocked = blockText(option, t, locale);
  if (blocked) parts.push(blocked);
  else if (option.partial) parts.push(t('localModels.catalog.selects.partial'));
  return parts.join(' · ');
}

export function contextOptionText(
  option: ChoiceOption<number>,
  t: TFunction,
  locale: string,
  current = false,
  recommended = false,
): string {
  const parts = [contextLabel(option.value)];
  if (current) return parts[0] ?? '';
  if (recommended) parts.push(t('localModels.catalog.selects.recommended'));
  const blocked = blockText(option, t, locale);
  if (blocked) parts.push(blocked);
  else if (option.partial) parts.push(t('localModels.catalog.selects.partial'));
  return parts.join(' · ');
}
