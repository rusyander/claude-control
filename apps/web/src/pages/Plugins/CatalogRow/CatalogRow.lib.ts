/** Тысячи сокращаем: точное число установок роли не играет. */
export function formatCount(count: number): string {
  return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
}
