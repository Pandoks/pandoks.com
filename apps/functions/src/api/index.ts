import { deployHandler } from './blog';

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/blog/deploy':
        return deployHandler(request);
      default:
        return new Response('Not Found', { status: 404 });
    }
  }
};
