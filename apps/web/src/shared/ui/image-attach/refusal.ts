import type { ImageRefusal } from '@shared/lib/attach';

/** Всё, что не приложилось за одно вложение, по причинам. */
export interface ImageRefusals {
  notImage: string[];
  tooLarge: { name: string; size: number }[];
  tooMany: string[];
  failed: { name: string; reason: Exclude<ImageRefusal, 'not-image'> }[];
}

export const NO_REFUSALS: ImageRefusals = { notImage: [], tooLarge: [], tooMany: [], failed: [] };

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Отказ одной строкой: каждая причина своим предложением, у размера — настоящий
 * размер рядом с пределом. Пусто — сказать нечего.
 */
export function refusalText(
  refusals: ImageRefusals,
  t: Translate,
  size: (bytes: number) => string,
  limits: { maxBytes: number; maxCount: number },
): string | undefined {
  const parts: string[] = [];
  if (refusals.notImage.length > 0) {
    parts.push(t('attach.notImage', { names: refusals.notImage.join(', ') }));
  }
  if (refusals.tooLarge.length > 0) {
    parts.push(
      t('attach.tooLarge', {
        names: refusals.tooLarge.map((file) => `${file.name} — ${size(file.size)}`).join(', '),
        limit: size(limits.maxBytes),
      }),
    );
  }
  if (refusals.tooMany.length > 0) {
    parts.push(t('attach.tooMany', { names: refusals.tooMany.join(', '), limit: limits.maxCount }));
  }
  const unreadable = refusals.failed.filter((item) => item.reason === 'unreadable');
  if (unreadable.length > 0) {
    parts.push(t('attach.unreadable', { names: unreadable.map((item) => item.name).join(', ') }));
  }
  const shrink = refusals.failed.filter((item) => item.reason === 'too-large');
  if (shrink.length > 0) {
    parts.push(t('attach.shrinkFailed', { names: shrink.map((item) => item.name).join(', ') }));
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}
