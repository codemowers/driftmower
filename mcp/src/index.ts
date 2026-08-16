#!/usr/bin/env node

import { loadAppConfig } from './config.js'
import { SqliteReportSnapshotRepository } from './db/report-snapshot-repository.js'
import { checkDatabaseSchema } from './db/schema-check.js'
import { openReadOnlyDatabase, type Database } from './db/sqlite.js'
import { SqliteWorkloadRepository } from './db/workload-repository.js'
import { startHealthServer } from './http/health.js'
import { createLogger } from './logger.js'
import { createMcpServer } from './mcp/create-server.js'
import { startHttpTransport } from './mcp/transports/http.js'
import { startStdioTransport } from './mcp/transports/stdio.js'
import { WorkloadSearchService } from './services/workload-search-service.js'

async function main(): Promise<void> {
  const appConfig = loadAppConfig()
  const logger = createLogger(appConfig.logLevel)
  const healthServer =
    appConfig.transport === 'http'
      ? await startHealthServer({
          host: appConfig.host,
          port: appConfig.healthPort,
          databasePath: appConfig.databasePath
        })
      : undefined
  let database: Database | undefined

  try {
    database = await openReadOnlyDatabase(appConfig.databasePath)
    await checkDatabaseSchema(database)
    const reportSnapshotRepository = new SqliteReportSnapshotRepository(database)
    const repository = new SqliteWorkloadRepository(database, reportSnapshotRepository)
    const workloadSearchService = new WorkloadSearchService(
      repository,
      appConfig.defaultLimit,
      appConfig.maximumLimit
    )
    const createServer = (): ReturnType<typeof createMcpServer> => createMcpServer({ workloadSearchService })

    if (appConfig.transport === 'stdio') {
      const mcpServer = createServer()

      await startStdioTransport(mcpServer)
      logger.info('Driftmower MCP server started', { transport: 'stdio' })

      return
    }

    const httpServer = await startHttpTransport(createServer, {
      host: appConfig.host,
      port: appConfig.port
    })

    logger.info('Driftmower MCP server started', {
      transport: 'http',
      host: appConfig.host,
      port: appConfig.port,
      healthPort: appConfig.healthPort
    })

    registerShutdown(async () => {
      await Promise.all([
        closeServer(httpServer),
        healthServer ? closeServer(healthServer) : Promise.resolve(),
        database?.destroy()
      ])
    })
  } catch (error) {
    await database?.destroy()

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
