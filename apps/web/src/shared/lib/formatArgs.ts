export function formatArgs(args: string[]): string {
  return args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ');
}
