// Транспорт: чистые функции, ничего не знающие про React.

export const path = (id: string, suffix = ''): string =>
  `/platforms/${encodeURIComponent(id)}${suffix}`;
