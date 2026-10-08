import styles from './ProjectTestsRunBar.module.scss';

/** Доли полосы состояния — в том же порядке, что и числа в подписи. */
export const STACK_PARTS = ['passed', 'failed', 'skipped', 'rest'] as const;

export const PART_CLASS: Record<(typeof STACK_PARTS)[number], string | undefined> = {
  passed: styles.miniStackPassed,
  failed: styles.miniStackFailed,
  skipped: styles.miniStackSkipped,
  rest: styles.miniStackRest,
};
