import { Text } from 'react-native';
import type { ProjectTestPyramid } from '@agentdeck/contracts';
import { Card, Muted } from '../../../shared/ui';
import { useT } from '../../../shared/config/i18n';
import { pyramidRows } from '../../../entities/tests/pyramid';
import { styles } from './TestPyramidCard.styles';

/**
 * Пирамида тестов — только чтение: сколько модульных и интеграционных стоит
 * рядом с e2e. Слой без каркаса, названного проектом, — «не известно», а не
 * ноль; деление — только по меткам самого проекта (считает сервер).
 */
export function TestPyramidCard({ pyramid }: { pyramid: ProjectTestPyramid | undefined }) {
  const t = useT();
  if (!pyramid) return null;
  const words = t.tests.pyramid;

  return (
    <Card>
      <Text style={styles.title}>{words.title}</Text>
      {pyramidRows(pyramid).map((row) => {
        const empty = row.layer === 'e2e' ? words.noFolder : words.unknown;
        const value = row.count ? words.count(row.count.tests, row.count.files) : empty;
        return (
          <Text key={row.layer} style={styles.row}>
            {`${words.layers[row.layer]}: ${value}`}
          </Text>
        );
      })}
      {pyramid.frameworks.length === 0 ? <Muted>{words.noFramework}</Muted> : null}
      {pyramid.frameworks.length > 0 && !pyramid.split ? <Muted>{words.unsplit}</Muted> : null}
      {pyramid.truncated ? <Muted>{words.truncated}</Muted> : null}
    </Card>
  );
}
