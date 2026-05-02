export const FONTS = [
  { file: 'Inter.woff2', family: 'Inter', weight: '100 900', style: 'normal', key: 'inter' },
  {
    file: 'Inter-Italic.woff2',
    family: 'Inter',
    weight: '100 900',
    style: 'italic',
    key: 'inter-italic'
  },
  {
    file: 'EBGaramond.woff2',
    family: 'EB Garamond',
    weight: '400 800',
    style: 'normal',
    key: 'garamond'
  },
  {
    file: 'EBGaramond-Italic.woff2',
    family: 'EB Garamond',
    weight: '400 800',
    style: 'italic',
    key: 'garamond-italic'
  }
];

export const FONT_FAMILIES = {
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
