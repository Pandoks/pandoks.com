import { describe, test, expect } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/svelte';
import Page from './+page.svelte';

describe('/+page.svelte', () => {
  test('links to the Human Experience blog post', () => {
    render(Page);
    const link = screen.getByRole('link', { name: 'Human Experience' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/blog/The-Human-Experience');
  });
});
