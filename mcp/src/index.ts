#!/usr/bin/env node

import { setTimeout, clearTimeout } from 'node:timers'

import { loadEngineeringAdvisories } from './advisory/software-engineering.js'

import { createBearerAuthenticator } from './auth/bearer.js'
import { DriftmowerBackendClient } from './backend/client.js'
import { BackendImageUpdateRepository } from './backend/image-update-repository.js'
import { BackendReportSnapshotRepository } from './backend/report-snapshot-repository.js'
import { ReportRowLoader } from './backend/report-rows.js'
import { BackendWorkloadRepository } from './backend/workload-repository.js'
import { discoverClusterIdentity } from './services/cluster-identity.js'
import { checkAuthorizer } from './services/identity-diagnostics.js'
import { loadAppConfig, type AppConfig } from './config.js'
import { closeHttpServer } from './http/shutdown.js'
import { ApplicationMetrics } from './http/metrics.js'
import { startHealthServer } from './http/health.js'
import { createLogger } from './logger.js'
import { createMcpServer } from './mcp/create-server.js'
import { MCP_PATH, startHttpTransport } from './mcp/transports/http.js'
import { startStdioTransport } from './mcp/transports/stdio.js'
import { ImageUpdatePlanningService } from './services/image-update-planning-service.js'
import { createKubernetesServices } from './services/kubernetes-services.js'
import { WorkloadSearchService } from './services/workload-search-service.js'

async function main(): Promise<void> {
  const appConfig = loadAppConfig()
  const advisories = loadEngineeringAdvisories(appConfig.advisoryOverrideDirectory)
  const logger = createLogger(appConfig.logLevel)
  const client =
    appConfig.backendEnabled === false
      ? undefined
      : new DriftmowerBackendClient({
          baseUrl: appConfig.backendUrl,
          serviceToken: appConfig.backendServiceToken,
          timeoutMs: appConfig.backendTimeoutMs
        })
  let ready = false
  const metrics = new ApplicationMetrics()
  const healthServer =
    appConfig.transport === 'http'
      ? await startHealthServer({
          host: appConfig.host,
          port: appConfig.healthPort,
          isReady: () => ready,
          metrics
        })
      : undefined

  try {
    const driftmower = client ? createDriftmowerServices(client, appConfig) : {}
    const kubernetesServices = createKubernetesServices(
      appConfig.kubernetes,
      appConfig.observability,
      appConfig.tenancy,
      appConfig.provisioning
    )

    appConfig.cluster = await discoverClusterIdentity(
      appConfig.cluster,
      kubernetesServices.kubeloginIngress,
      message => logger.warn(message),
      appConfig.oidc?.issuer
    )

    if (appConfig.transport === 'http') {
      const diagnostics = await checkAuthorizer(
        kubernetesServices.kubernetes.allowed,
        appConfig.kubernetes.usernamePrefix
      )

      if (diagnostics.warning) logger.warn(diagnostics.warning)
      else logger.info('Kubernetes authorizer answers SubjectAccessReviews')
    }

    const createServer = (): ReturnType<typeof createMcpServer> =>
      createMcpServer({
        ...driftmower,
        cluster: appConfig.cluster,
        advisories,
        ...kubernetesServices,
        audit: line => logger.info(line)
      })

    if (appConfig.transport === 'stdio') {
      const mcpServer = createServer()

      await startStdioTransport(mcpServer)
      logger.info('Driftmower MCP server started', { transport: 'stdio' })
      registerShutdown(() => mcpServer.close())

      return
    }

    const authenticator = appConfig.oidc
      ? createBearerAuthenticator(
          {
            issuer: appConfig.oidc.issuer,
            jwksUri: appConfig.oidc.jwksUri,
            audience: appConfig.oidc.audience ?? undefined,
            publicUrl: appConfig.publicUrl,
            namespacesClaim: appConfig.oidc.namespacesClaim,
            jwksBearerTokenFile: appConfig.oidc.jwksBearerTokenFile,
            identityClaims: {
              username: appConfig.kubernetes.usernameClaim,
              groups: appConfig.kubernetes.groupsClaim
            }
          },
          MCP_PATH
        )
      : undefined

    if (!authenticator) {
      logger.warn(
        'HTTP transport is serving unauthenticated; do not expose it through an Ingress in this state'
      )
    }

    const httpServer = await startHttpTransport(createServer, {
      host: appConfig.host,
      port: appConfig.port,
      metrics,
      authenticator,
      cluster: appConfig.cluster,
      advisories,
      oauthClientId: appConfig.oauthClientId,
      capabilities: {
        service: kubernetesServices.provisioning.service,
        identityMapping: kubernetesServices.provisioning.identityMapping,
        onAudit: line => logger.info(line)
      },
      invalidate: {
        sharedToken: appConfig.invalidate.sharedToken,
        allowedSubjects: appConfig.invalidate.allowedSubjects,
        tokenReview: kubernetesServices.tokenReview,
        ...kubernetesServices.invalidation,
        onInvalidate: (source, scope, cleared) => {
          metrics.invalidations.inc({ source })
          logger.info('Cache invalidated', { source, scope, cleared })
        }
      },
      onError: error => logger.error(errorMessage(error)),
      onAudit: entry =>
        entry.event === 'rejected'
          ? logger.warn('MCP request rejected', { subject: entry.subject, reason: entry.reason })
          : logger.debug('MCP session accepted', { subject: entry.subject })
    })

    logger.info('Driftmower MCP server started', {
      transport: 'http',
      host: appConfig.host,
      port: appConfig.port,
      healthPort: appConfig.healthPort,
      authenticated: Boolean(authenticator),
      observability: Boolean(kubernetesServices.observability),
      landingPath: '/'
    })

    const watch = appConfig.kubernetes.rbacWatchEnabled
      ? kubernetesServices.createWatch(
          (message, metadata) => logger.warn(message, metadata),
          source => metrics.invalidations.inc({ source })
        )
      : null

    watch?.start()

    if (watch) logger.info('Watching RBAC, namespaces and CRDs to invalidate caches on change')
    else logger.info('RBAC watch disabled; caches expire by TTL only')

    ready = true
    registerShutdown(async () => {
      ready = false
      await Promise.all([
        closeHttpServer(httpServer),
        healthServer ? closeHttpServer(healthServer) : Promise.resolve(),
        watch?.stop() ?? Promise.resolve()
      ])
    })
  } finally {
    // A failed startup must release the probe listener and fail the process.
    if (!ready && healthServer) await closeHttpServer(healthServer)
  }
}

function createDriftmowerServices(client: DriftmowerBackendClient, appConfig: AppConfig) {
  const rowLoader = new ReportRowLoader(client)
  const reportSnapshotRepository = new BackendReportSnapshotRepository(client)
  const repository = new BackendWorkloadRepository(rowLoader, reportSnapshotRepository)

  return {
    workloadSearchService: new WorkloadSearchService(
      repository,
      appConfig.defaultLimit,
      appConfig.maximumLimit
    ),
    imageUpdatePlanningService: new ImageUpdatePlanningService(
      new BackendImageUpdateRepository(rowLoader),
      reportSnapshotRepository,
      appConfig.defaultLimit,
      appConfig.maximumLimit
    )
  }
}

main().catch((error: unknown) => {
  createLogger().error(errorMessage(error))
  process.exit(1)
})

function registerShutdown(close: () => Promise<void>): void {
  let closing = false

  const handleSignal = (): void => {
    if (closing) {
      return
    }

    closing = true
    const deadline = setTimeout(() => {
      createLogger().error('Shutdown exceeded 25 seconds')
      process.exit(1)
    }, 25_000)

    void close().then(() => {
      clearTimeout(deadline)
      process.exit(0)
    })
  }

  process.once('SIGINT', handleSignal)
  process.once('SIGTERM', handleSignal)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
