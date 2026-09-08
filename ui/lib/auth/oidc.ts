import "server-only"

import * as oidc from "openid-client"

export interface OidcRuntimeConfig {
  issuer: string
  clientId: string
  clientSecret: string
  appBaseUrl: string
  redirectUri: string
  postLogoutRedirectUri: string
  scope: string
  // RFC 8707 resource indicator; must equal the backend's OIDC_AUDIENCE exactly.
  resource: string
}

function requireEnv(name: string): string {
  const value = process.env[name]

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

export function getOidcRuntimeConfig(): OidcRuntimeConfig {
  const appBaseUrl = requireEnv("APP_BASE_URL").replace(/\/+$/, "")

  return {
    issuer: requireEnv("OIDC_IDP_URI"),
    clientId: requireEnv("OIDC_CLIENT_ID"),
    clientSecret: requireEnv("OIDC_CLIENT_SECRET"),
    appBaseUrl,
    redirectUri: `${appBaseUrl}/api/auth/callback`,
    postLogoutRedirectUri: `${appBaseUrl}/`,
    // applications gates passmower's per-user /api/apps launcher list,
    // which backs the Applications page.
    // `namespaces` carries the codemowers.io/namespaces claim (the accessible
    // namespace set) into tokens for tenancy scoping in driftmower-be.
    scope: process.env.OIDC_SCOPE || "openid profile groups applications namespaces offline_access",
    resource: requireEnv("OIDC_AUDIENCE"),
  }
}

let configPromise: Promise<oidc.Configuration> | null = null

export function getOidcConfig(): Promise<oidc.Configuration> {
  if (!configPromise) {
    const cfg = getOidcRuntimeConfig()
    const server = new URL(cfg.issuer)
    const insecure = server.protocol === "http:"

    configPromise = oidc
      .discovery(
        server,
        cfg.clientId,
        cfg.clientSecret,
        // passmower registers clients with client_secret_basic;
        // openid-client v6 defaults to client_secret_post.
        oidc.ClientSecretBasic(cfg.clientSecret),
        insecure ? { execute: [oidc.allowInsecureRequests] } : undefined
      )
      .then((config) => {
        // Also needed on the config itself for the later token/refresh calls.
        if (insecure) {
          oidc.allowInsecureRequests(config)
        }

        return config
      })
      .catch((error) => {
        configPromise = null
        throw error
      })
  }

  return configPromise
}
