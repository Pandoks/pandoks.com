import { render } from '@testing-library/svelte';
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
    }
  };
}

describe('blog vim navigation', () => {
  it('keeps keyboard navigation within the generated blog fixture', () => {
    const vimState = createVimState();
    render(Page, { context: new Map([['$_vim_state', vimState]]) });
    const blogCount = define.__BLOG_TITLES__.length;
    const key = (value: 'j' | 'k') => new KeyboardEvent('keypress', { key: value });

    expect(blogCount).toBeGreaterThan(0);
    vimState.initBodyState?.(key('j'));
    expect(vimState.bodyTop).toBe(true);
    expect(vimState.bodyBottom).toBe(blogCount === 1);

    vimState.bodyHandler?.(key('k'));
    expect(vimState.bodyTop).toBe(true);

    for (let index = 1; index < blogCount; index++) {
      vimState.bodyHandler?.(key('j'));
    }
    expect(vimState.bodyTop).toBe(blogCount === 1);
    expect(vimState.bodyBottom).toBe(true);

    vimState.bodyHandler?.(key('j'));
    expect(vimState.bodyBottom).toBe(true);

    for (let index = 1; index < blogCount; index++) {
      vimState.bodyHandler?.(key('k'));
    }
    expect(vimState.bodyTop).toBe(true);
    expect(vimState.bodyBottom).toBe(blogCount === 1);

    vimState.bodyHandler?.(key('k'));
    expect(vimState.bodyTop).toBe(true);
  });
});
