/** Подпись места по доле в видеопамяти: целиком на карте, целиком на процессоре или пополам. */
export function placeKey(percent: number): string {
  if (percent >= 99) return 'localModels.device.onGpu';
  if (percent <= 0) return 'localModels.device.onCpu';
  return 'localModels.device.split';
}
