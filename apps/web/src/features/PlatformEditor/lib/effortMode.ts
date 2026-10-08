export function effortMode(value: boolean | undefined): 'preset' | 'on' | 'off' {
  if (value === undefined) return 'preset';
  return value ? 'on' : 'off';
}
