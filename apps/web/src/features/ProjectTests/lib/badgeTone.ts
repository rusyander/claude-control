export function badgeTone(status: string): 'info' | 'success' | 'danger' | 'warning' {
  if (status === 'running') return 'info';
  if (status === 'done') return 'success';
  if (status === 'error') return 'danger';
  return 'warning';
}
