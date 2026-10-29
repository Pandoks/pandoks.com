import { Text, VStack } from '@expo/ui/swift-ui';
import { containerBackground, font, foregroundStyle, frame } from '@expo/ui/swift-ui/modifiers';
import { createWidget } from 'expo-widgets';

export type FocusWidgetProps = { title: string; caption: string };

export default createWidget<FocusWidgetProps>(
  'FocusWidget',
  (props) => {
    'widget';
    return (
      <VStack
        alignment="leading"
        spacing={4}
        modifiers={[
          frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: 'bottomLeading' }),
          containerBackground({ type: 'hierarchical', style: 'quinary' }, 'widget')
        ]}
      >
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle('#FF9F0A')]}>
          FOCUS
        </Text>
        <Text modifiers={[font({ size: 22, weight: 'bold' })]}>{props.title}</Text>
        <Text
          modifiers={[
            font({ size: 13 }),
            foregroundStyle({ type: 'hierarchical', style: 'secondary' })
          ]}
        >
          {props.caption}
        </Text>
      </VStack>
    );
  },
  { title: 'No sessions', caption: 'Start one in the app' }
);
