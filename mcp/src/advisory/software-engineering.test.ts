import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ENGINEERING_ADVISORIES, loadEngineeringAdvisories } from './software-engineering.js'

const directories: string[] = []

function directory() {
  const path = mkdtempSync(join(tmpdir(), 'advisory-test-'))

  directories.push(path)

  return path
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('cluster advisory overrides', () => {
  it('replaces matching paths, keeps defaults and loads projected ConfigMap symlinks', () => {
    const root = directory()

    mkdirSync(join(root, '..data', 'deploying'), { recursive: true })
    symlinkSync('..data/deploying', join(root, 'deploying'))
    writeFileSync(
      join(root, '..data', 'networking.md'),
      '# Local networking\n\nUse the local ingress class.\n'
    )
    symlinkSync('../networking.md', join(root, '..data', 'deploying', 'networking.md'))
    writeFileSync(join(root, 'deploying', 'custom.md'), '# Custom platform\n\nAdditional policy.\n')
    const result = loadEngineeringAdvisories(root)

    expect(result.find(section => section.path === 'deploying/networking')).toMatchObject({
      title: 'Local networking',
      source: 'override',
      text: 'Use the local ingress class.'
    })
    expect(result.find(section => section.path === 'developing/general')).toEqual(
      ENGINEERING_ADVISORIES.find(section => section.path === 'developing/general')
    )
    expect(result).toHaveLength(ENGINEERING_ADVISORIES.length + 1)
    expect(result.every(section => !section.path.includes('..data'))).toBe(true)
    expect(
      loadEngineeringAdvisories(null).find(section => section.path === 'deploying/networking')?.source
    ).toBe('bundled')
  })

  it('discovers dotted CRD paths and replaces an override at exactly that path', () => {
    const root = directory()

    mkdirSync(join(root, 'crds'))
    writeFileSync(join(root, 'crds', 'widget.example.io.md'), '# Fixture\n\nFirst revision.\n')
    const first = loadEngineeringAdvisories(root)

    expect(first.filter(section => section.path === 'crds/widget.example.io')).toHaveLength(1)
    writeFileSync(join(root, 'crds', 'widget.example.io.md'), '# Fixture\n\nSecond revision.\n')
    expect(
      loadEngineeringAdvisories(root).find(section => section.path === 'crds/widget.example.io')
    ).toMatchObject({ source: 'override', text: 'Second revision.' })
  })

  it('rejects empty dotted path components', () => {
    const root = directory()

    writeFileSync(join(root, 'widget..example.md'), '# Fixture\n\nInvalid path.\n')
    expect(() => loadEngineeringAdvisories(root)).toThrow('Invalid advisory path')
  })

  it('fails on missing mounts, malformed Markdown and reserved index paths', () => {
    const root = directory()

    expect(() => loadEngineeringAdvisories(join(root, 'missing'))).toThrow()
    writeFileSync(join(root, 'bad.md'), 'No heading')
    expect(() => loadEngineeringAdvisories(root)).toThrow('must start with a Markdown title')
    writeFileSync(join(root, 'bad.md'), '# Valid\n\nText')
    writeFileSync(join(root, 'index.md'), '# Index\n\nNo')
    expect(() => loadEngineeringAdvisories(root)).toThrow('index is generated automatically')
  })
})
