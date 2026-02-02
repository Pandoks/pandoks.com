import { formatTitle } from './format-title';

const cases: Array<[string, string]> = [['  hello   expo router  ', 'Hello Expo Router']];

cases.forEach(([input, expected]) => {
  const result = formatTitle(input);
  if (result !== expected) {
    throw new Error(`Expected "${expected}", got "${result}"`);
  }
});
