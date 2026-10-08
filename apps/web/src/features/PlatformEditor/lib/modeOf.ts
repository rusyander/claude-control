import type { PathMode } from '../ui/StepAddressManifest/StepAddressManifest.types';

export function modeOf(value: string | undefined): PathMode {
  if (value === undefined) return 'preset';
  return value === '' ? 'none' : 'custom';
}
