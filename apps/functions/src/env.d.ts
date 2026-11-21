// NOTE: infra/api.ts checks each Lambda's environment against these with `satisfies`
export interface TextSmsEnvironment {
  TWILIO_PHONE_NUMBER: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_NOTION_MESSAGING_SERVICE_SID: string;
}

export interface NotionWebhookEnvironment {
  DOMAIN: string;
  SCHEDULER_INVOKE_ROLE_ARN: string;
  SCHEDULER_GROUP_NAME: string;
  TEXT_FUNCTION_ARN: string;
  GITHUB_NOTION_SYNC_URL: string;
  GITHUB_PERSONAL_ACCESS_TOKEN: string;
  NOTION_API_KEY: string;
  NOTION_WEBHOOK_VERIFICATION_TOKEN: string;
  NOTION_BLOG_DATABASE_ID: string;
  KWOK_PHONE_NUMBER: string;
  MICHELLE_PHONE_NUMBER: string;
}

// NOTE: Lambda sets these itself and rejects them in a function's environment
export interface LambdaRuntimeEnvironment {
  AWS_REGION: string;
}
