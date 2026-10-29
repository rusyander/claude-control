const PORT_MIN = 1024;

const PORT_MAX = 65535;

export function parsePort(raw: string): number | undefined {
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= PORT_MIN && value <= PORT_MAX ? value : undefined;
}
