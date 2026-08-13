import { render } from '@testing-library/svelte';
import { getBlogBoundaries, hasBlogNavigation } from '$lib/blog-navigation';
import { describe, expect, it } from 'vitest';
import { define } from '../../../vite/globals';
import Page from './+page.svelte';

type KeyHandler = (event: KeyboardEvent) => void;

function createVimState() {
  return {
    active: 'body' as const,
    bodyTop: false,
    bodyBottom: true,
    bodyHandler: undefined as KeyHandler | undefined,
    initBodyState: undefined as KeyHandler | undefined,
    bodyCleared: false,
    setBodyHandler(handler: KeyHandler) {
      this.bodyHandler = handler;
      return this;
    },
    setInitBodyState(handler: KeyHandler) {
      this.initBodyState = handler;
      return this;
    },
    setResetBodyState() {
      return this;
    },
    clearBody() {
      this.bodyCleared = true;
    }
  };
}

describe('blog vim navigation', () => {
  it('does not expose body navigation for an empty list', () => {
    expect(hasBlogNavigation(0)).toBe(false);
    expect(getBlogBoundaries(undefined, 0)).toEqual({ bodyTop: true, bodyBottom: true });
  });

  it('sets both boundaries for a one-post list', () => {
    expect(hasBlogNavigation(1)).toBe(true);
    expect(getBlogBoundaries(0, 1)).toEqual({ bodyTop: true, bodyBottom: true });
  });

  it('handles a fixed multiple-post cursor', () => {
    expect(hasBlogNavigation(3)).toBe(true);
    expect(getBlogBoundaries(0, 3)).toEqual({ bodyTop: true, bodyBottom: false });
    expect(getBlogBoundaries(1, 3)).toEqual({ bodyTop: false, bodyBottom: false });
    expect(getBlogBoundaries(2, 3)).toEqual({ bodyTop: false, bodyBottom: true });
  });

  it('wires body navigation according to the generated blog fixture', () => {
    const vimState = createVimState();
    render(Page, { context: new Map([['$_vim_state', vimState]]) });
    const blogCount = define.__BLOG_TITLES__.length;

    if (blogCount === 0) {
      expect(vimState.bodyCleared).toBe(true);
      expect(vimState.bodyHandler).toBeUndefined();
      return;
    }

    vimState.initBodyState?.(new KeyboardEvent('keypress', { key: 'j' }));
    expect(vimState.bodyTop).toBe(true);
    expect(vimState.bodyBottom).toBe(blogCount === 1);
  });
});
