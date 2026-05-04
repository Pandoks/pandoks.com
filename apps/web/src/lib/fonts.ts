export type FontKey = 'inter' | 'inter-italic' | 'garamond' | 'garamond-italic';
export type FontFamily = 'Inter' | 'EB Garamond';

export type Font = {
  file: string;
  family: FontFamily;
  weight: string;
  style: 'normal' | 'italic';
};

export const FONTS: Record<FontKey, Font> = {
  inter: { file: 'Inter.woff2', family: 'Inter', weight: '100 900', style: 'normal' },
  'inter-italic': {
    file: 'Inter-Italic.woff2',
    family: 'Inter',
    weight: '100 900',
    style: 'italic'
  },
  garamond: { file: 'EBGaramond.woff2', family: 'EB Garamond', weight: '400 800', style: 'normal' },
  'garamond-italic': {
    file: 'EBGaramond-Italic.woff2',
    family: 'EB Garamond',
    weight: '400 800',
    style: 'italic'
  }
};

export const FONT_FAMILIES: Record<FontFamily, { stack: string[]; cssVariables: string[] }> = {
  Inter: {
    stack: [
      'Inter-Inline',
      'Inter',
      'ui-sans-serif',
      'system-ui',
      '-apple-system',
      'BlinkMacSystemFont',
      'Segoe UI',
      'Roboto',
      'Helvetica Neue',
      'Arial',
      'Noto Sans',
      'sans-serif'
    ],
    cssVariables: ['--font-inter', '--font-sans']
  },
  'EB Garamond': {
    stack: [
      'EB Garamond-Inline',
      'EB Garamond',
      'ui-serif',
      'Georgia',
      'Cambria',
      'Times New Roman',
      'Times',
      'serif'
    ],
    cssVariables: ['--font-garamond', '--font-serif']
  }
};
