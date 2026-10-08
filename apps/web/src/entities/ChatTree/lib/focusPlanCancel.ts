/** Довести человека до кнопки «Отменить план» в хабе — прокрутить и поставить фокус. */
export function focusPlanCancel(root: ParentNode = document): boolean {
  const button = root.querySelector<HTMLElement>('[data-plan-cancel]');
  if (!button) return false;
  button.scrollIntoView({ block: 'center', behavior: 'smooth' });
  button.focus();
  return true;
}
