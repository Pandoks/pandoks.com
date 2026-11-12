import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';
import { NavigationBar } from 'expo-navigation-bar';
import { Platform, StatusBar, useColorScheme } from 'react-native';

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      {/* NOTE: iOS's default status bar follows the theme; Android's system bar icons don't */}
      {Platform.OS === 'android' && (
        <StatusBar barStyle={colorScheme === 'dark' ? 'light-content' : 'dark-content'} />
      )}
      <NavigationBar style="auto" />
      <NativeTabs>
        <NativeTabs.Trigger name="index">
          <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf={{ default: 'house', selected: 'house.fill' }} md="home" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="focus">
          <NativeTabs.Trigger.Label>Focus</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf="timer" md="timer" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="device">
          <NativeTabs.Trigger.Label>Device</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf="iphone" md="smartphone" />
        </NativeTabs.Trigger>
      </NativeTabs>
    </ThemeProvider>
  );
}
