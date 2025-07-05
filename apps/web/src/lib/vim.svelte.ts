import { getContext, onMount, setContext } from 'svelte';

type NoArgFunction = () => void;
type KeyEventFunction = (e: KeyboardEvent) => void;

interface Vim {
  active: 'nav' | 'body' | 'none';
  bodyTop: boolean;
  bodyBottom: boolean;

  setNavHandler: (navHandler: KeyEventFunction) => Vim;
  setInitNavState: (initNavState: NoArgFunction | KeyEventFunction) => Vim;
  setResetNavState: (resetNavState: NoArgFunction) => Vim;

  setBodyHandler: (bodyHandler: KeyEventFunction) => Vim;
  setInitBodyState: (initBodyState: NoArgFunction | KeyEventFunction) => Vim;
  setResetBodyState: (resetBodyState: NoArgFunction) => Vim;

  clearBody: NoArgFunction;
}

class VimClass implements Vim {
  private navHandler: KeyEventFunction = () => {};
  private initNavState: NoArgFunction | KeyEventFunction = () => {};
  private resetNavState: NoArgFunction = () => {};

  private bodyHandler: KeyEventFunction | undefined = undefined;
  private initBodyState: NoArgFunction | KeyEventFunction | undefined = undefined;
  private resetBodyState: NoArgFunction | undefined = undefined;

  active: 'nav' | 'body' | 'none' = $state('none');
  bodyTop = true;
  bodyBottom = true;

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
            this.bodyTop = true;
            this.bodyBottom = true;
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
          this.initBodyState(e);
          this.active = 'body';
          return;
        }
        if (!this.bodyBottom) return;
        this.initNavState(e);
        this.active = 'nav';
        return;
      case 'k':
        if (!this.initBodyState || !this.bodyHandler) {
          if (this.active === 'nav') return;
          this.initNavState(e);
          this.active = 'nav';
          return;
        }
        if (this.active === 'body') {
          if (!this.bodyTop) return;
          this.initNavState(e);
          this.active = 'nav';
          return;
        }
        this.initBodyState(e);
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

  clearBody: NoArgFunction = () => {
    this.bodyHandler = undefined;
    this.initBodyState = undefined;
    this.resetBodyState = undefined;
    this.bodyTop = true;
    this.bodyBottom = true;
  };

  setNavHandler(navHandler: KeyEventFunction) {
    this.navHandler = navHandler;
    return this;
  }

  setInitNavState(initNavState: NoArgFunction | KeyEventFunction) {
    this.initNavState = initNavState;
    return this;
  }

  setResetNavState(resetNavState: NoArgFunction) {
    this.resetNavState = resetNavState;
    return this;
  }

  setBodyHandler(bodyHandler: KeyEventFunction) {
    this.bodyHandler = bodyHandler;
    return this;
  }

  setInitBodyState(initBodyState: NoArgFunction | KeyEventFunction) {
    this.initBodyState = initBodyState;
    return this;
  }

  setResetBodyState(resetBodyState: NoArgFunction) {
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
