#!/usr/bin/env node

import { createBearerAuthenticator } from './auth/bearer.js'
import { DriftmowerBackendClient } from './backend/client.js'
import { BackendImageUpdateRepository } from './backend/image-update-repository.js'
import { BackendReportSnapshotRepository } from './backend/report-snapshot-repository.js'
import { ReportRowLoader } from './backend/report-rows.js'
import { BackendWorkloadRepository } from './backend/workload-repository.js'
import { createDriftmowerUiClient } from './clients/driftmower-ui.js'
import { loadAppConfig, type AppConfig } from './config.js'
import { startHealthServer } from './http/health.js'
import { createLogger, type Logger } from './logger.js'
import { createMcpServer } from './mcp/create-server.js'
import { MCP_PATH, startHttpTransport } from './mcp/transports/http.js'
import { startStdioTransport } from './mcp/transports/stdio.js'
import { ImageUpdatePlanningService } from './services/image-update-planning-service.js'
import { ProvisioningService } from './services/provisioning-service.js'
import { WorkloadSearchService } from './services/workload-search-service.js'

async function main(): Promise<void> {
  const appConfig = loadAppConfig()
  const logger = createLogger(appConfig.logLevel)
  const client = new DriftmowerBackendClient({
    baseUrl: appConfig.backendUrl,
    serviceToken: appConfig.backendServiceToken,
    timeoutMs: appConfig.backendTimeoutMs
  })
  const healthServer =
    appConfig.transport === 'http'
      ? await startHealthServer({
          host: appConfig.host,
          port: appConfig.healthPort,
          client
        })
      : undefined

  try {
    const rowLoader = new ReportRowLoader(client)
    const reportSnapshotRepository = new BackendReportSnapshotRepository(client)
    const repository = new BackendWorkloadRepository(rowLoader, reportSnapshotRepository)
    const workloadSearchService = new WorkloadSearchService(
      repository,
      appConfig.defaultLimit,
      appConfig.maximumLimit
    )
    const imageUpdateRepository = new BackendImageUpdateRepository(rowLoader)
    const imageUpdatePlanningService = new ImageUpdatePlanningService(
      imageUpdateRepository,
      reportSnapshotRepository,
      appConfig.defaultLimit,
      appConfig.maximumLimit
    )
    const provisioningService = createProvisioningService(appConfig, logger)
    const createServer = (): ReturnType<typeof createMcpServer> =>
      createMcpServer({
        workloadSearchService,
        imageUpdatePlanningService,
        provisioningService,
        audit: line => logger.info(line)
      })

    if (appConfig.transport === 'stdio') {
      const mcpServer = createServer()

      await startStdioTransport(mcpServer)
      logger.info('Driftmower MCP server started', { transport: 'stdio' })

      return
    }

    const authenticator = appConfig.oidc
      ? createBearerAuthenticator(
          {
            issuer: appConfig.oidc.issuer,
            jwksUri: appConfig.oidc.jwksUri,
            audience: appConfig.oidc.audience ?? undefined,
            publicUrl: appConfig.publicUrl,
            namespacesClaim: appConfig.oidc.namespacesClaim
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
      authenticator,
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
      provisioning: Boolean(provisioningService)
    })

    registerShutdown(async () => {
      await Promise.all([
        closeServer(httpServer),
        healthServer ? closeServer(healthServer) : Promise.resolve()
      ])
    })
  } catch (error) {
    if (!healthServer) {
      throw error
    }

    logger.error(errorMessage(error))
    logger.warn('Health server remains available while MCP startup is not ready', {
      healthPort: appConfig.healthPort
    })
    registerShutdown(() => closeServer(healthServer))
  }
}

main().catch((error: unknown) => {
  createLogger().error(errorMessage(error))
  process.exitCode = 1
})

function createProvisioningService(appConfig: AppConfig, logger: Logger): ProvisioningService | undefined {
  if (!appConfig.provisioning) {
    logger.info('Provisioning tools are not registered: DRIFTMOWER_UI_URL is unset')

    return undefined
  }

  return new ProvisioningService(
    createDriftmowerUiClient({
      baseUrl: appConfig.provisioning.driftmowerUiUrl,
      requestTimeoutMs: appConfig.provisioning.requestTimeoutMs
    })
  )
}

function closeServer(server: import('node:http').Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()))
  })
}

function registerShutdown(close: () => Promise<void>): void {
  let closing = false

  const handleSignal = (): void => {
    if (closing) {
      return
    }

    closing = true
    void close().catch((error: unknown) => createLogger().error(errorMessage(error)))
  }

  process.once('SIGINT', handleSignal)
  process.once('SIGTERM', handleSignal)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
