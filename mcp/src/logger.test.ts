import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from './logger.js'

describe('createLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes logs to stderr and never stdout', () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    createLogger('debug').info('started', { transport: 'stdio' })

    expect(stderrWrite).toHaveBeenCalledWith('[info] started {"transport":"stdio"}\n')
    expect(stdoutWrite).not.toHaveBeenCalled()
  })
})
