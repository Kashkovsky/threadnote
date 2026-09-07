import {describeFlag, integerFlag, optional, optionalString, repeatedString} from './cli_flags.js';

export const makeComposerAttachFlags = () => ({
  composerClientId: optionalString(
    'composer-client-id',
    'Registered public OAuth client ID for the organization composer',
  ),
  composerUrl: optionalString('composer-url', 'Organization composer Streamable HTTP MCP URL'),
  composerOAuthScopes: repeatedString(
    'composer-oauth-scope',
    'Additional provider OAuth scope (Cursor/Codex); repeat for multiple',
    32,
  ),
  composerCallbackUrl: optionalString('composer-callback-url', 'Registered Codex direct-loopback OAuth callback URL'),
  composerCallbackPort: optional(
    describeFlag(
      integerFlag('composer-callback-port'),
      'Codex OAuth callback listener port matching the registered URL',
    ),
  ),
  shareId: optionalString('share-id', 'Organization composer share binding'),
});
