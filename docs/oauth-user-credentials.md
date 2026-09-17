# OAuth user credentials for graph sharing

Threadnote supports OAuth 2.0 Device Authorization for interactive graph and registry access. The generic configuration
accepts exact endpoints and claim mapping, so the product does not branch on the provider name. The pilot profile uses
an Okta custom authorization server. Existing Auth0 configuration files and helper names remain readable aliases.

## Okta custom authorization server

Create a public Native application with Device Authorization and Refresh Token grants. Assign only the scopes needed by
the selected resource. Use a 5–10 minute access-token lifetime and rotating refresh tokens. For an issuer such as
`https://example.okta.com/oauth2/threadnote`, configure these exact values:

- device authorization: `https://example.okta.com/oauth2/threadnote/v1/device/authorize`
- token: `https://example.okta.com/oauth2/threadnote/v1/token`
- JWKS: `https://example.okta.com/oauth2/threadnote/v1/keys`
- client-ID claim: `cid`
- audience request parameter: omitted

The issuer path is part of the authority and is preserved exactly. All three endpoints must be canonical HTTPS URLs on
the issuer origin. Redirects are refused. The graph audience and registry audience must remain distinct.

Configure the graph client, then complete the one-time device login:

```sh
threadnote graph auth configure \
  --issuer https://example.okta.com/oauth2/threadnote \
  --device-authorization-url https://example.okta.com/oauth2/threadnote/v1/device/authorize \
  --token-url https://example.okta.com/oauth2/threadnote/v1/token \
  --jwks-url https://example.okta.com/oauth2/threadnote/v1/keys \
  --client-id-claim cid \
  --client-id OKTA_NATIVE_CLIENT_ID \
  --audience https://graph.example.com \
  --coordinator https://graph.example.com/team \
  --organization pilot
threadnote graph auth login
```

Configure registry read access with a separate Native application and exact admitted subject:

```sh
threadnote graph auth registry configure \
  --issuer https://example.okta.com/oauth2/threadnote-registry \
  --device-authorization-url https://example.okta.com/oauth2/threadnote-registry/v1/device/authorize \
  --token-url https://example.okta.com/oauth2/threadnote-registry/v1/token \
  --jwks-url https://example.okta.com/oauth2/threadnote-registry/v1/keys \
  --client-id-claim cid \
  --client-id OKTA_REGISTRY_READER_CLIENT_ID \
  --audience https://registry.example.com \
  --origin https://registry.example.com \
  --organization pilot \
  --subject OKTA_READER_SUBJECT
threadnote graph auth registry login
```

The registry command installs `docker-credential-threadnote-oauth-user` for that exact host. Refresh tokens stay in
macOS Keychain. Public configuration contains issuer, endpoints, audience, client ID, claim mapping, organization, and
the optional expected subject; it never contains a refresh token, access token, or client secret.

## Token validation

Threadnote verifies RS256 signatures through the configured JWKS endpoint and requires the exact issuer, audience,
client ID, subject continuity, scopes, and bounded lifetime. Okta `scp` arrays and OAuth `scope` strings are accepted; if
both are present, their distinct scope sets must agree. The device login requests `offline_access` plus
`graph:read graph:contribute` or `registry:read`. Generic Okta configuration omits `audience` from the device request
unless `--audience-parameter` is explicitly supplied.

Registry tokens may carry only `registry:read`. A registry subject configured during setup must match every initial and
refreshed token. A refresh is marked uncertain before exchange so Threadnote does not replay a rotating refresh token
after an interrupted Keychain update.

## Existing Auth0 installations

Commands without any explicit endpoint or client-claim flags retain the legacy Auth0 profile: root issuer,
`oauth/device/code`, `oauth/token`, `.well-known/jwks.json`, the graph or registry audience request parameter, and
`azp`/`client_id` selection. Legacy `auth0-user*.json`, `helper: auth0`, `__graph-auth0-helper`, and
`docker-credential-threadnote-auth0-user` remain readable. The next explicit generic configure migrates public bindings
to schema v2; the user may need to run login again because the Keychain account is bound to the complete provider
authority.
