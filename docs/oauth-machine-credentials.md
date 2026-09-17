# OAuth machine credentials for graph sharing

Threadnote's noninteractive machine helpers support OAuth 2.0 client credentials with RS256 access tokens, including an
Okta **custom authorization server**. Configure the custom server's audience, application access policy, allowed scopes,
and access-token lifetime before enabling a helper. Use a 5–10 minute lifetime (300–600 seconds). The Okta organization
server and its API service scopes are not the graph-sharing authority.

## Commands and private configuration

- `threadnote-credential-oauth-m2m get` supplies graph control credentials (`helper: oauth-m2m`).
- `docker-credential-threadnote-oauth-m2m get` supplies Zot worker credentials.
- `docker-credential-threadnote-oauth-publisher-m2m get` supplies Zot canonical publisher credentials.

The graph helper reads a schema-v1 JSON request on stdin. Docker helpers read one exact registry host followed by a
newline. Helpers print the existing credential JSON protocol on success. Failures print a generic message to stderr,
leave stdout empty, and never print the provider response, client secret, or token. Store credentials in private runtime
configuration or a secret manager; do not add secrets or issued tokens to Git.

The graph authority uses `THREADNOTE_OAUTH_GRAPH_M2M_` followed by these field names:

| Field                                                                | Meaning                                                                                   |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ISSUER`                                                             | Exact HTTPS issuer, e.g. `https://example.okta.com/oauth2/threadnote`                     |
| `TOKEN_URL`                                                          | Explicit token endpoint, e.g. `https://example.okta.com/oauth2/threadnote/v1/token`       |
| `JWKS_URL`                                                           | Explicit verification endpoint, e.g. `https://example.okta.com/oauth2/threadnote/v1/keys` |
| `CLIENT_AUTHENTICATION`                                              | `client_secret_basic` (Okta) or `client_secret_post`                                      |
| `CLIENT_ID_CLAIM`                                                    | `cid` (Okta), `azp`, `client_id`, or legacy `azp-or-client_id`                            |
| `AUDIENCE`                                                           | Expected token audience, configured as the exact graph HTTPS authority                    |
| `AUDIENCE_PARAMETER`                                                 | Optional `audience` form value; omit for Okta                                             |
| `CLIENT_ID`, `CLIENT_SECRET`, `SUBJECT`                              | Dedicated graph application credentials and exact expected token subject                  |
| `COORDINATOR_URL`, `ORGANIZATION`, `REPOSITORY_ID`, `PROFILE_DIGEST` | Exact enrolled graph binding                                                              |
| `SCOPES`                                                             | Space-separated distinct subset of `graph:read graph:contribute`                          |

Both endpoints must be canonical HTTPS URLs on the issuer's origin, with no credentials, query, or fragment. Issuer
paths are preserved exactly; a trailing slash changes the issuer identity. Endpoint paths are never inferred for generic
configuration. HTTP redirects are refused when exchanging the client secret. Basic authentication form-encodes each
credential before constructing the Basic header. The expected token audience is always required even when no `audience`
parameter is sent.

For Zot, use `THREADNOTE_OAUTH_REGISTRY_M2M_` for `ISSUER`, `TOKEN_URL`, `JWKS_URL`, `CLIENT_AUTHENTICATION`,
`CLIENT_ID_CLAIM`, optional `AUDIENCE_PARAMETER`, `AUDIENCE`, and `ORIGIN`. Both audience and origin must equal the exact
Zot HTTPS origin. Worker credentials use this same prefix for `CLIENT_ID`, `CLIENT_SECRET`, and `SUBJECT`; publisher
credentials instead use `THREADNOTE_OAUTH_PUBLISHER_M2M_` for those three private fields. Publisher and worker share the
registry provider settings but have distinct applications, secrets, and subjects. Known graph/worker/publisher credential
reuse is rejected. Provision graph and registry audiences on separate custom authorization servers if the provider
configures one audience per server; each helper accepts its own exact issuer and endpoints.

Configure Docker's `credHelpers` map for the exact registry host with `threadnote-oauth-m2m` or
`threadnote-oauth-publisher-m2m`. Worker tokens request only `registry:worker`; publisher tokens request only
`registry:publisher`. Zot admission must map the configured token subjects to the corresponding repository ACL roles.
Registry credentials are released only to the exact Zot Bearer realm `<registry-origin>/zot/auth/token`.

## Token validation

Every token must pass signature verification and exact issuer, single audience, configured subject, selected client-ID
claim, and scope checks. Scopes may use the OAuth `scope` string or Okta `scp` array; if both appear, they must agree.
Duplicate or unauthorized scopes are rejected. Graph tokens may contain the configured graph grant, including the
requested scope; registry tokens must contain only the role's single scope. Issued-at, not-before, expiry, response
`expires_in`, minimum remaining lifetime, and the 600-second maximum are checked. A response scope, when present, must
match the JWT's scope set. A configured subject is required; it is never derived from the client ID.

## Publisher container

The graph publisher image uses the generic publisher Docker helper. Set `THREADNOTE_GRAPH_OAUTH_ISSUER`,
`THREADNOTE_GRAPH_OAUTH_AUDIENCE`, and explicit `THREADNOTE_GRAPH_OAUTH_JWKS_URL` to the graph control policy's exact
values. Set the registry provider configuration and publisher credentials above. Preflight verifies these against the
persisted enrollment, profile, policy, and signing key before starting the listener. A registry authorization server may
have a different issuer from graph control; its own explicit endpoints must stay on its issuer origin.

The checked-in Fly example keeps the existing Auth0 deployment values; replace them with your actual custom-server
configuration during an Okta deployment. A passing offline preflight does not establish successful live token issuance or
Zot ACL admission: smoke-test both registry roles and graph read/contribute using the deployed authority.

## Existing Auth0 installations

The old Auth0 command names and `THREADNOTE_AUTH0_{GRAPH,REGISTRY,PUBLISHER}_M2M_*` environment names remain aliases.
Legacy root issuers retain `oauth/token`, `.well-known/jwks.json`, `client_secret_post`, the audience form parameter, and
`azp`/`client_id` selection. Conflicting generic and legacy values fail closed. When migrating an issuer to the generic
name, provide its explicit endpoint, authentication, and claim settings. Interactive user/device authorization is documented in [OAuth user credentials](oauth-user-credentials.md).
