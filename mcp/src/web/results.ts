export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]

    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"'
        i++
      } else quoted = !quoted
    } else if (c === ',' && !quoted) {
      row.push(field)
      field = ''
    } else if (c === '\n' && !quoted) {
      row.push(field.replace(/\r$/, ''))
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }

  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

export function argumentExample(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined
  const required = Array.isArray(schema.required) ? schema.required : []

  return Object.fromEntries(
    required
      .filter((key): key is string => typeof key === 'string')
      .map(key => {
        const value = properties?.[key] ?? {}

        return [
          key,
          value.default ??
            (Array.isArray(value.enum)
              ? value.enum[0]
              : value.type === 'array'
                ? []
                : value.type === 'object'
                  ? argumentExample(value)
                  : value.type === 'boolean'
                    ? false
                    : value.type === 'integer' || value.type === 'number'
                      ? (value.minimum ?? 1)
                      : '')
        ]
      })
  )
}
