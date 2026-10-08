/**
 * Один жест «потяните вниз»: крутилка горит, пока не закончатся все перезапросы, и гаснет,
 * даже если какой-то из них упал — иначе на недоступной панели она крутилась бы вечно.
 */
export async function pullOnce(
  refetches: ReadonlyArray<() => Promise<unknown>>,
  setRefreshing: (value: boolean) => void,
): Promise<void> {
  setRefreshing(true);
  try {
    await Promise.allSettled(refetches.map((refetch) => refetch()));
  } finally {
    setRefreshing(false);
  }
}
