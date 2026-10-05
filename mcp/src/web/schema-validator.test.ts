import { describe, expect, it } from 'vitest'
import { AjvJsonSchemaValidator as BrowserSchemaValidator } from './schema-validator.js'

describe('browser schema validation', () => {
  it('validates nested output schemas and rejects invalid results', () => {
    const validate = new BrowserSchemaValidator().getValidator({
      type: 'object',
      required: ['namespaces'],
      properties: { namespaces: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false
    })

    expect(validate({ namespaces: ['demo'] }).valid).toBe(true)
    expect(validate({ namespaces: [42] }).valid).toBe(false)
    expect(validate({}).valid).toBe(false)
    expect(validate({ namespaces: [], unexpected: true }).valid).toBe(false)
  })
})
