function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function format(value: unknown, unit: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unavailable'

  if (unit === 'ratio')
    return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 2 }).format(value)

  if (unit === 'bytes' || unit === 'bytes/second') {
    const suffix = unit === 'bytes/second' ? '/s' : ''
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let index = 0

    while (Math.abs(value) >= 1024 && index < units.length - 1) {
      value /= 1024
      index += 1
    }

    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)} ${units[index]}${suffix}`
  }

  return `${new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 }).format(value)} ${String(unit ?? '')}`.trim()
}

export function resourceUsageTable(result: Record<string, unknown>) {
  const historical = !!result.history
  const headers = [
    'Metric',
    'Source metrics',
    'Resource',
    'Current',
    ...(historical
      ? ['Average', 'Min', 'Max', 'Stddev', 'Samples / expected', 'First sample', 'Last sample']
      : []),
    'Notes'
  ]
  const rows: string[][] = []

  function row(
    name: string,
    resource: string,
    value: unknown,
    unit: unknown,
    statistics: unknown,
    notes: string[],
    sources: unknown
  ) {
    const stats = record(statistics)

    rows.push([
      name,
      Array.isArray(sources) ? sources.join('\n') : 'Unspecified',
      resource,
      format(value, unit),
      ...(historical
        ? [
            format(stats.avg, unit),
            format(stats.min, unit),
            format(stats.max, unit),
            format(stats.stddev, unit),
            typeof stats.sampleCount === 'number'
              ? `${stats.sampleCount} / ${stats.expectedSamples}`
              : 'Unavailable',
            String(stats.firstSampleAt ?? 'Unavailable'),
            String(stats.lastSampleAt ?? 'Unavailable')
          ]
        : []),
      notes.join('\n')
    ])
  }

  for (const [name, raw] of Object.entries(record(result.metrics))) {
    const quantity = record(raw)
    const notes = [
      quantity.error,
      quantity.statisticsError,
      ...(Array.isArray(quantity.warnings) ? quantity.warnings : [])
    ].filter((value): value is string => typeof value === 'string')

    row(name, 'Total', quantity.total, quantity.unit, quantity.statistics, notes, quantity.sourceMetrics)
    const current = Array.isArray(quantity.breakdown) ? quantity.breakdown.map(record) : []
    const history = Array.isArray(quantity.historyBreakdown) ? quantity.historyBreakdown.map(record) : []
    const key = (sample: Record<string, unknown>) =>
      JSON.stringify(Object.entries(record(sample.labels)).sort(([a], [b]) => a.localeCompare(b)))
    const samples = new Map(current.map(sample => [key(sample), sample]))

    for (const sample of history) {
      const id = key(sample)

      samples.set(id, { ...samples.get(id), ...sample })
    }

    for (const sample of samples.values()) {
      const labels = record(sample.labels)
      const resource =
        ['node', 'container', 'persistentvolumeclaim', 'device', 'mountpoint', 'device_class', 'interface']
          .flatMap(key => (typeof labels[key] === 'string' ? [`${key}: ${labels[key]}`] : []))
          .join(', ') || 'Series'

      row(name, resource, sample.value, quantity.unit, sample.statistics, [], quantity.sourceMetrics)
    }
  }

  const history = record(result.history)
  const summary = historical
    ? `Requested: ${history.requestedStart} – ${history.requestedEnd}. Available samples: ${history.firstSampleAt ?? 'none'} – ${history.lastSampleAt ?? 'none'}. Statistics use sampled values and population standard deviation.`
    : `Snapshot at ${result.observedAt ?? 'unknown time'}. Rates cover the preceding ${result.windowSeconds ?? 300} seconds.`

  return {
    headers,
    rows,
    summary: [
      summary,
      ...(Array.isArray(result.notes) ? result.notes.filter(item => typeof item === 'string') : [])
    ].join('\n')
  }
}
