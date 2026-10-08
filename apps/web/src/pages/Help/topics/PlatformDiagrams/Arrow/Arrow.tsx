import styles from './Arrow.module.scss';

/** Стрелка со стрелочным наконечником, нарисованным как треугольник. */
export function Arrow({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const size = 7;
  const tip = `${x2},${y2}`;
  const left = `${x2 - size * Math.cos(angle - 0.4)},${y2 - size * Math.sin(angle - 0.4)}`;
  const right = `${x2 - size * Math.cos(angle + 0.4)},${y2 - size * Math.sin(angle + 0.4)}`;
  return (
    <>
      <line x1={x1} y1={y1} x2={x2} y2={y2} className={styles.arrow} />
      <polygon points={`${tip} ${left} ${right}`} className={styles.arrowHead} />
    </>
  );
}
