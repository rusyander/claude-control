/** Момент из ISO-строки или миллисекунд; битое значение — `undefined`. */
export function moment(at: string | number): Date | undefined {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}
