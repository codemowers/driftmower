import { describe, expect, it } from 'vitest'
import { argumentExample, parseCsv } from './results.js'

describe('explorer results', () => {
  it('parses policy descriptions containing commas, quotes and newlines', () => {
    expect(parseCsv('name,description\r\npolicy,"Quote ""this"",\nand that"\r\n')).toEqual([
      ['name', 'description'],
      ['policy', 'Quote "this",\nand that']
    ])
  })
  it('creates arguments from required schema properties only', () => {
    expect(
      argumentExample({
        required: ['namespace', 'limit', 'mode', 'optional'],
        properties: {
          namespace: { type: 'string' },
          limit: { type: 'integer', minimum: 5 },
          mode: { enum: ['summary', 'full'] },
          optional: { type: 'boolean', default: true },
          ignored: { type: 'string' }
        }
      })
    ).toEqual({ namespace: '', limit: 5, mode: 'summary', optional: true })
  })
})
