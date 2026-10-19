import type { AppMarkProps } from './AppMark.types';

/**
 * Знак приложения: пульт управления как кольцо с делениями и точкой отсчёта.
 * Нарисован разметкой, а не картинкой, — так он берёт цвет темы и остаётся
 * чётким в любом размере, включая свёрнутую панель.
 */
export function AppMark({ size = 32 }: AppMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      {/* Геометрия — как у `public/favicon.svg`; заливка — акцент темы, а не градиент значка. */}
      <rect width="32" height="32" rx="8" fill="var(--color-accent)" />
      <circle
        cx="16"
        cy="16"
        r="8.6"
        stroke="var(--color-accent-fg)"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeDasharray="4.2 4.8"
        transform="rotate(-75 16 16)"
      />
      <circle cx="16" cy="16" r="3.3" fill="var(--color-accent-fg)" />
    </svg>
  );
}
