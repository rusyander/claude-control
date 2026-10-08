/** Якорь адреса без решётки; битая %-последовательность — не якорь, а не исключение. */
export function anchorOf(hash: string): string {
  const raw = hash.replace(/^#/, '');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}
