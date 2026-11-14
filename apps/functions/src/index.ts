import { webhookHandler } from './api/notion/webhook';

export { TextReminderWorkflow } from './api/notion/text-reminder';

export default {
  fetch: (request) =>
    new URL(request.url).pathname === '/notion/webhook'
      ? webhookHandler(request)
      : new Response('Not Found', { status: 404 })
} satisfies ExportedHandler<Env>;
