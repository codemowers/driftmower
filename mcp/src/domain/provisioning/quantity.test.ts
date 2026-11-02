import { expect, it } from 'vitest'

import { formatCpu, formatGi, parseCount, parseCpuMillis, parseQuantity } from './quantity.js'

it('binary suffixes are powers of 1024', () => {
  expect(parseQuantity('1Ki')).toBe(1024)
  expect(parseQuantity('2Gi')).toBe(2 * 1024 ** 3)
  expect(parseQuantity('256Mi')).toBe(256 * 1024 ** 2)
  expect(parseQuantity('10Gi')).toBe(10 * 1024 ** 3)
})

it('decimal suffixes are powers of 1000 and are not confused with binary', () => {
  expect(parseQuantity('1k')).toBe(1000)
  expect(parseQuantity('1G')).toBe(1e9)
  // The whole point: 1G and 1Gi are different numbers.
  expect(parseQuantity('1G')).not.toBe(parseQuantity('1Gi'))
})

it('milli and bare values parse, which is how cpu quotas are written', () => {
  expect(parseQuantity('100m')).toBe(0.1)
  expect(parseQuantity('1')).toBe(1)
  expect(parseCpuMillis('100m')).toBe(100)
  expect(parseCpuMillis('1')).toBe(1000)
  expect(parseCpuMillis('1.5')).toBe(1500)
})

it('decimals and leading-dot values parse', () => {
  expect(parseQuantity('1.5Gi')).toBe(1.5 * 1024 ** 3)
  expect(parseQuantity('0.5')).toBe(0.5)
  expect(parseQuantity('.5')).toBe(0.5)
})

it('unparseable input is null, never zero', () => {
  // Zero would silently read as "nothing used", inventing quota headroom.
  expect(parseQuantity(undefined)).toBe(null)
  expect(parseQuantity(null)).toBe(null)
  expect(parseQuantity('')).toBe(null)
  expect(parseQuantity('  ')).toBe(null)
  expect(parseQuantity('lots')).toBe(null)
  expect(parseQuantity('10Gb')).toBe(null)
  expect(parseQuantity('1Gi2')).toBe(null)
})

it('counts round to integers, for pods and pvc limits', () => {
  expect(parseCount('50')).toBe(50)
  expect(parseCount('5')).toBe(5)
})

it('formatting keeps whole numbers whole', () => {
  expect(formatGi(10 * 1024 ** 3)).toBe('10Gi')
  expect(formatGi(1.5 * 1024 ** 3)).toBe('1.5Gi')
  expect(formatCpu(1000)).toBe('1')
  expect(formatCpu(100)).toBe('100m')
})

it('binary and decimal suffixes are not interchangeable in either direction', () => {
  // Uppercase K is only valid with the "i": "K" alone is not a Kubernetes suffix.
  expect(parseQuantity('1K')).toBe(null)
  // ...and the decimal kilo is lowercase, so "ki" is not a suffix either.
  expect(parseQuantity('1ki')).toBe(null)
  expect(parseQuantity('1Ki')).toBe(1024)
  expect(parseQuantity('1k')).toBe(1000)
})
