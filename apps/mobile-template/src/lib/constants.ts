/**
 * App-specific constants.
 * These are values unique to this application.
 */

export const APP_NAME = 'MyApp';
export const APP_VERSION = '1.0.0';

export const API_CONFIG = {
  baseUrl: process.env.EXPO_PUBLIC_API_URL ?? 'https://api.example.com',
  timeout: 10000
} as const;
