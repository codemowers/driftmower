# Passmower OIDC clients — OIDCClient.codemowers.cloud

Qualified kind: `OIDCClient.codemowers.cloud`. CRD: `oidcclients.codemowers.cloud`. Example API version: `codemowers.cloud/v1`. Scope: namespaced.

Register an application with Passmower for delegated authentication instead of implementing application-owned accounts. Discover the advertised capability, served API version, live schema, operator health, namespace permissions, and applicable policy bindings before provisioning this resource. Do not assume another identity provider or optional platform component is installed.

- Register browser authentication declaratively with `OIDCClient.codemowers.cloud`, using authorization code flow with PKCE and explicit HTTPS redirect URIs. Consume the generated client credentials through Secret references; configure API issuer and audience consistently. Keep confidential client credentials on the server.
- Read the OIDC issuer from the operator-generated owner Secret `oidc-client-<OIDCClient-name>-owner-secrets`, key `OIDC_IDP_URI`, through `valueFrom.secretKeyRef`. Map that key to the application's `OIDC_ISSUER` or equivalent environment variable; do not duplicate the issuer in Helm values or hardcode it in application manifests.
- Deploy Passmower 2.7.0 or later and source the public application origin from the same owner Secret's `OIDC_CLIENT_ORIGIN` value. For a Next.js application using NextAuth, map it to `NEXTAUTH_URL` through `valueFrom.secretKeyRef`, rather than maintaining another Helm URL value. Use the origin, not the OIDC issuer URL or a redirect URI containing a callback path. If the field is missing, require the deployment to use Passmower 2.7.0 or later and verify Secret reconciliation; do not build application or manifest workarounds. Keep these values server-side.
- Verify how the installed Passmower version configures and grants custom scopes and resource audiences. Declaring `spec.availableScopes` does not replace API-side token validation or business authorization.

## Operator-provisioned OIDCClient Secret

For `OIDCClient.codemowers.cloud`, the operator creates `oidc-client-<OIDCClient-name>-owner-secrets` in the OIDCClient's namespace. Reference its fields directly instead of duplicating issuer endpoints or client credentials in application configuration. The table describes decoded values; Kubernetes stores them as base64 under Secret `data`.

| Key | Decoded value and use |
| --- | --- |
| `OIDC_CLIENT_ID` | Client identifier, `<namespace>.<OIDCClient-name>`. |
| `OIDC_CLIENT_SECRET` | Operator-generated client secret for client authentication; keep it on the server. |
| `OIDC_CLIENT_ORIGIN` | Public application origin, for example `https://app.example.com`, without a callback path. Requires Passmower 2.7.0 or later. |
| `OIDC_IDP_URI` | Issuer base URL; map to the application's issuer setting. |
| `OIDC_IDP_WELL_KNOWN_URI` | OpenID Connect discovery document URL. |
| `OIDC_IDP_AUTH_URI` | Authorization endpoint URL. |
| `OIDC_IDP_TOKEN_URI` | Token endpoint URL. |
| `OIDC_IDP_USERINFO_URI` | UserInfo endpoint URL. |
| `OIDC_GRANT_TYPES` | Comma-separated grant types from `spec.grantTypes`. |
| `OIDC_RESPONSE_TYPES` | Comma-separated response types from `spec.responseTypes`. |
| `OIDC_TOKEN_ENDPOINT_AUTH_METHOD` | Client authentication method from `spec.tokenEndpointAuthMethod`. |
| `OIDC_ID_TOKEN_SIGNED_RESPONSE_ALG` | ID token signing algorithm from `spec.idTokenSignedResponseAlg`. |
| `OIDC_REDIRECT_URIS` | Comma-separated callback URIs from `spec.redirectUris`. |
| `OIDC_AVAILABLE_SCOPES` | Scopes from `spec.availableScopes`, comma-separated by default; `spec.availableScopesDelimiter` controls the separator. |
| `OIDC_ALLOWED_GROUPS` | Comma-separated group allowlist from `spec.allowedGroups`. |
| `OIDC_ALLOWED_USERS` | Comma-separated account-ID allowlist from `spec.allowedUsers`. |

List-valued fields are strings, not JSON arrays. If a client expects space-separated scopes, set `spec.availableScopesDelimiter` to a single space. Use explicit environment-variable mappings when the application uses different names. To inspect available keys without displaying credentials:

```sh
kubectl get secret oidc-client-example-frontend-owner-secrets -n <namespace> \
  -o go-template='{{range $key, $value := .data}}{{$key}}{{"\n"}}{{end}}'
```

Example mapping for an OIDCClient named `example-frontend` (requires Passmower 2.7.0 or later):

```yaml
env:
  - name: OIDC_CLIENT_ID
    valueFrom:
      secretKeyRef:
        name: oidc-client-example-frontend-owner-secrets
        key: OIDC_CLIENT_ID
  - name: OIDC_CLIENT_SECRET
    valueFrom:
      secretKeyRef:
        name: oidc-client-example-frontend-owner-secrets
        key: OIDC_CLIENT_SECRET
  - name: OIDC_ISSUER
    valueFrom:
      secretKeyRef:
        name: oidc-client-example-frontend-owner-secrets
        key: OIDC_IDP_URI
  - name: NEXTAUTH_URL
    valueFrom:
      secretKeyRef:
        name: oidc-client-example-frontend-owner-secrets
        key: OIDC_CLIENT_ORIGIN
```
