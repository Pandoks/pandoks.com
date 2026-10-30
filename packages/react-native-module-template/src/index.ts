import { NativeModule, requireNativeModule, requireNativeView } from 'expo';
import { type ColorValue, type ViewProps } from 'react-native';

declare class ModuleTemplateModule extends NativeModule<{
  onChange: (event: { value: string }) => void;
}> {
  getGreeting(): string | null;
  setValueAsync(value: string): Promise<void>;
}

export const ModuleTemplate = requireNativeModule<ModuleTemplateModule>('ModuleTemplate');

export const ModuleTemplateView = requireNativeView<
  ViewProps & { text: string; color: ColorValue }
>('ModuleTemplate');
