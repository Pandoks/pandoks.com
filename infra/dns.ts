import { secrets, setSecret } from './secrets';

export const isProduction = $app.stage === 'production';

export const domain = isProduction ? 'pandoks.com' : 'dev.pandoks.com';

export const EXAMPLE_DOMAIN = 'example.pandoks.com';

export const STAGE_NAME = isProduction ? 'prod' : 'dev';

secrets.Stage.value.apply((stageName) => {
  if (stageName !== STAGE_NAME) {
    setSecret(secrets.Stage.name, STAGE_NAME);
  }
});
