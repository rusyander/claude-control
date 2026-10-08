import type { StepPreview } from '../model/previewSteps';

export function tileSteps(preview: StepPreview | undefined): string[] | undefined {
  if (!preview) return undefined;
  if (preview.titles.length === 0 && preview.waiting > 0) return undefined;
  return preview.titles;
}
