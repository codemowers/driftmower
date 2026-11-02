import { expect, it } from 'vitest'
import { resourceUsageTable } from './resource-usage.js'

it('renders resource totals with units and keeps snapshot columns distinct from statistics', () => {
  const result = resourceUsageTable({
    observedAt: 'now',
    windowSeconds: 300,
    metrics: {
      memoryUsage: { unit: 'bytes', total: 1073741824 },
      cpuUsed: { unit: 'cores', total: null, error: 'Unavailable exporter' }
    }
  })

  expect(result.headers).not.toContain('Average')
  expect(result.rows[0]).toEqual(['memoryUsage', 'Unspecified', 'Total', '1 GiB', ''])
  expect(result.rows[1]).toEqual(['cpuUsed', 'Unspecified', 'Total', 'Unavailable', 'Unavailable exporter'])
})
it('renders historical series without current samples and includes their actual timestamps', () => {
  const statistics = {
    avg: 0.1,
    min: 0,
    max: 0.2,
    stddev: 0.05,
    sampleCount: 3,
    expectedSamples: 61,
    firstSampleAt: 'start',
    lastSampleAt: 'end'
  }
  const result = resourceUsageTable({
    history: {
      requestedStart: 'requested',
      requestedEnd: 'now',
      firstSampleAt: 'start',
      lastSampleAt: 'end'
    },
    metrics: {
      cpuUsed: {
        unit: 'cores',
        total: null,
        statistics,
        historyBreakdown: [{ labels: { container: 'completed' }, statistics }]
      }
    }
  })

  expect(result.headers).toContain('Average')
  expect(result.rows[1]).toEqual([
    'cpuUsed',
    'Unspecified',
    'container: completed',
    'Unavailable',
    '0.1 cores',
    '0 cores',
    '0.2 cores',
    '0.05 cores',
    '3 / 61',
    'start',
    'end',
    ''
  ])
  expect(result.summary).toContain('Available samples: start – end')
})
