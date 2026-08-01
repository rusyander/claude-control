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
      <rect width="32" height="32" rx="9" fill="var(--color-accent)" />
      <circle
        cx="16"
        cy="16"
        r="8.5"
        stroke="var(--color-accent-fg)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="3.4 4.2"
        opacity="0.75"
      />
      <circle cx="16" cy="16" r="3.2" fill="var(--color-accent-fg)" />
    </svg>
  );
}
