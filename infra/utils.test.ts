import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderCloudInit } from './utils';

test('renders cloud-init environment placeholders', () => {
  const config = [
    'host: ${HOST}',
    'token: ${TOKEN}',
    'host-again: ${HOST}',
    'missing: ${MISSING}',
    'lowercase: ${ignored}'
  ].join('\n');

  assert.equal(
    renderCloudInit(config, { HOST: 'dev-box', TOKEN: undefined }),
    ['host: dev-box', 'token: ', 'host-again: dev-box', 'missing: ', 'lowercase: ${ignored}'].join(
      '\n'
    )
  );
});
