import { Figure } from '../Figure/Figure';
import { Box } from '../Box/Box';
import { Arrow } from '../Arrow/Arrow';
import styles from './PlatformRequestDiagram.module.scss';
import type { DiagramProps } from '../PlatformDiagrams.types';

/** Диаграмма «путь одного запроса»: путь одного запроса и три места, где он может кончиться отказом. */
export function PlatformRequestDiagram({ tr }: DiagramProps) {
  return (
    <Figure title={tr('d2Title')} viewBox="0 0 700 470">
      <Box x={20} y={8} w={300} h={48} lines={[tr('d2Dialect')]} />
      <Arrow x1={170} y1={56} x2={170} y2={76} />
      <Box x={20} y={78} w={300} h={48} lines={[tr('d2Dlp')]} />
      <Arrow x1={170} y1={126} x2={170} y2={146} />
      <Box x={20} y={148} w={300} h={48} lines={[tr('d2Key')]} tone="accent" />
      <Arrow x1={170} y1={196} x2={170} y2={216} />

      <rect x={20} y={218} width={300} height={86} rx={8} className={styles.muted} />
      <text x={170} y={246} className={styles.label} textAnchor="middle">
        {tr('d2Contour')}
      </text>
      <text x={170} y={274} className={styles.note} textAnchor="middle">
        {tr('d2Inside')}
      </text>

      <Arrow x1={170} y1={304} x2={170} y2={324} />
      <Box x={20} y={326} w={300} h={48} lines={[tr('d2Translate')]} />
      <Arrow x1={170} y1={374} x2={170} y2={394} />
      <Box x={20} y={396} w={300} h={48} lines={[tr('d2Spend')]} />

      <Arrow x1={320} y1={252} x2={396} y2={212} />
      <Arrow x1={320} y1={261} x2={396} y2={281} />
      <Arrow x1={320} y1={270} x2={396} y2={350} />
      <Box x={398} y={188} w={288} h={48} lines={[tr('d2Blocked')]} tone="danger" />
      <Box x={398} y={257} w={288} h={48} lines={[tr('d2Budget')]} tone="danger" />
      <Box x={398} y={326} w={288} h={48} lines={[tr('d2Limit')]} tone="danger" />
    </Figure>
  );
}
