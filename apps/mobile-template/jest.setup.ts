// ─── Matcher types ────────────────────────────────────────────────────────
// expo-router registers these matchers at runtime but ships no types — augment jest's Matchers so tsc/eslint see them.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toHavePathname(pathname: string): R;
      toHavePathnameWithParams(pathname: string): R;
      toHaveSearchParams(params: Record<string, string | string[]>): R;
      toHaveSegments(segments: string[]): R;
      toHaveRouterState(state: unknown): R;
    }
  }
}

// ─── Setup stubs ──────────────────────────────────────────────────────────
// jest.mock(...) for native modules. jest-expo auto-mocks Expo modules, so add
// one only for a module the preset misses or a specific return value.
