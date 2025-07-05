import { getContext, onMount, setContext } from 'svelte';

interface Vim {
  active: 'nav' | 'body' | 'none';

  setNavHandler: (navHandler: (e: KeyboardEvent) => void) => Vim;
  setInitNavState: (initNavState: () => void) => Vim;
  setResetNavState: (resetNavState: () => void) => Vim;

  setBodyHandler: (bodyHandler: (e: KeyboardEvent) => void) => Vim;
  setInitBodyState: (initBodyState: () => void) => Vim;
  setResetBodyState: (resetBodyState: () => void) => Vim;

  clearBody: () => void;
}

class VimClass implements Vim {
  private navHandler: (e: KeyboardEvent) => void = () => {};
  private initNavState: () => void = () => {};
  private resetNavState: () => void = () => {};

  private bodyHandler: ((e: KeyboardEvent) => void) | undefined = undefined;
  private initBodyState: (() => void) | undefined = undefined;
  private resetBodyState: (() => void) | undefined = undefined;

  active: 'nav' | 'body' | 'none' = $state('none');

  constructor() {
    onMount(() => {
      document.addEventListener('keypress', this.masterEventListener);
      document.addEventListener('mousemove', () => {
        this.active = 'none';
      });

      $effect(() => {
        switch (this.active) {
          case 'nav':
            if (this.bodyHandler) {
              document.removeEventListener('keypress', this.bodyHandler);
            }
            document.addEventListener('keypress', this.navHandler);
            break;
          case 'body':
            document.removeEventListener('keypress', this.navHandler);
            document.addEventListener('keypress', this.bodyHandler!);
            break;
          case 'none':
            document.removeEventListener('keypress', this.navHandler);
            if (this.bodyHandler) {
              document.removeEventListener('keypress', this.bodyHandler);
            }
            this.resetNavState();
            this.resetBodyState?.();
        }
      });
    });
  }

  private masterEventListener = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'y':
        navigator.clipboard.writeText(window.location.href);
        return;
      case 'j':
        if (this.active === 'nav') {
          if (!(this.initBodyState && this.bodyHandler)) return;
          this.initBodyState();
          this.active = 'body';
          return;
        }
        this.initNavState();
        this.active = 'nav';
        return;
      case 'k':
        if (this.active === 'body' || !(this.initBodyState && this.bodyHandler)) {
          if (this.active === 'nav') return;
          this.initNavState();
          this.active = 'nav';
          return;
        }
        this.initBodyState();
        this.active = 'body';
        return;
      case 'Escape':
        this.active = 'none';
        return;
      default:
        if (this.active === 'none') {
          this.navHandler(e);
          this.active = 'nav';
        }
    }
  };

  clearBody: () => void = () => {
    this.bodyHandler = undefined;
    this.initBodyState = undefined;
    this.resetBodyState = undefined;
  };

  setNavHandler(navHandler: (e: KeyboardEvent) => void) {
    this.navHandler = navHandler;
    return this;
  }

  setInitNavState(initNavState: () => void) {
    this.initNavState = initNavState;
    return this;
  }

  setResetNavState(resetNavState: () => void) {
    this.resetNavState = resetNavState;
    return this;
  }

  setBodyHandler(bodyHandler: (e: KeyboardEvent) => void) {
    this.bodyHandler = bodyHandler;
    return this;
  }

  setInitBodyState(initBodyState: () => void) {
    this.initBodyState = initBodyState;
    return this;
  }

  setResetBodyState(resetBodyState: () => void) {
    this.resetBodyState = resetBodyState;
    return this;
  }
}

const DEFAULT_KEY = '$_vim_state';

export const getVimState = (key = DEFAULT_KEY) => {
  return getContext<Vim>(key);
};

export const setVimState = (key = DEFAULT_KEY) => {
  const vimState = new VimClass();
  return setContext(key, vimState);
};
