import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';
import { NavigationBar } from 'expo-navigation-bar';
import { useEffect } from 'react';
import { Platform, StatusBar, useColorScheme } from 'react-native';
import {
  registerDevice,
  useDevicePushToken,
  useNotificationRouting
} from '@pandoks.com/react-native-notifications';

const PUSH_SERVICE_URL = process.env.EXPO_PUBLIC_PUSH_SERVICE_URL;

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const { token } = useDevicePushToken();
  useNotificationRouting();

  useEffect(() => {
    if (token && PUSH_SERVICE_URL) {
      void registerDevice({ serviceUrl: PUSH_SERVICE_URL, token, userId: 'template' });
    }
  }, [token]);

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
        <NativeTabs.Trigger name="device">
          <NativeTabs.Trigger.Label>Device</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf="iphone" md="smartphone" />
        </NativeTabs.Trigger>
      </NativeTabs>
    </ThemeProvider>
  );
}
