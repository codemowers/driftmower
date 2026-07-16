#!/usr/bin/env node

import { loadAppConfig } from './config.js'
import { checkDatabaseSchema } from './db/schema-check.js'
import { openReadOnlyDatabase } from './db/sqlite.js'
import { createLogger } from './logger.js'

async function main(): Promise<void> {
  const appConfig = loadAppConfig()
  const logger = createLogger(appConfig.logLevel)
  const database = await openReadOnlyDatabase(appConfig.databasePath)

  try {
    await checkDatabaseSchema(database)
    logger.info('Driftmower database opened read-only and schema is compatible')
    logger.error('Server startup is not implemented until the remaining plan phases are complete')
  } finally {
    await database.destroy()
  }

  process.exitCode = 1
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)

  createLogger().error(message)
  process.exitCode = 1
})
