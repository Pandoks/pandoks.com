import { Column, Text } from '@expo/ui/jetpack-compose';
import { background, fillMaxSize, paddingAll } from '@expo/ui/jetpack-compose/modifiers';
import { createWidget } from 'expo-widgets';

import type { FocusWidgetProps } from './focus-widget';

export default createWidget<FocusWidgetProps>(
  'FocusWidget',
  (props, environment) => {
    'widget';
    const isDark = environment.colorScheme === 'dark';
    const shown = props.next && Date.now() >= props.next.date ? props.next : props;
    return (
      <Column
        verticalArrangement="bottom"
        modifiers={[fillMaxSize(), background(isDark ? '#1C1C1E' : '#FFFFFF'), paddingAll(16)]}
      >
        <Text color="#FF9F0A" style={{ fontSize: 13, fontWeight: 'bold' }}>
          FOCUS
        </Text>
        <Text color={isDark ? '#FFFFFF' : '#000000'} style={{ fontSize: 22, fontWeight: 'bold' }}>
          {shown.title}
        </Text>
        <Text color="#8E8E93" style={{ fontSize: 13 }}>
          {shown.caption}
        </Text>
      </Column>
    );
  },
  { title: 'No sessions', caption: 'Start one in the app' }
);
