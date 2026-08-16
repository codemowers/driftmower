import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import type { ImageUpdateFilters } from '../domain/image-update-plan.js'
import { decodeImageUpdateCursor, encodeImageUpdateCursor } from './image-update-cursor.js'

const FILTERS: ImageUpdateFilters = {
  namespace: 'apps',
  versionStatuses: ['major_behind', 'minor_behind']
}

describe('image update cursor', () => {
  it('round-trips the pinned report, filters, and sort key', () => {
    const cursor = encodeImageUpdateCursor('report-1', FILTERS, {
      riskRank: 1,
      actionType: 'image_tag_update',
      namespace: 'apps',
      groupKey: 'group-1'
    })

    expect(decodeImageUpdateCursor(cursor, FILTERS)).toMatchObject({
      version: 2,
      reportId: 'report-1',
      namespace: 'apps',
      versionStatuses: ['major_behind', 'minor_behind'],
      lastAction: {
        riskRank: 1,
        actionType: 'image_tag_update',
        namespace: 'apps',
        groupKey: 'group-1'
      }
    })
  })

  it('rejects malformed and noncanonical payloads', () => {
    const duplicateStatuses = encodePayload({
      version: 2,
      reportId: 'report-1',
      namespace: 'apps',
      versionStatuses: ['major_behind', 'major_behind'],
      lastAction: {
        riskRank: 0,
        actionType: 'image_tag_update',
        namespace: 'apps',
        groupKey: 'group-1'
      }
    })
    const wrongOrder = encodePayload({
      version: 2,
      reportId: 'report-1',
      namespace: 'apps',
      versionStatuses: ['minor_behind', 'major_behind'],
      lastAction: {
        riskRank: 0,
        actionType: 'image_tag_update',
        namespace: 'apps',
        groupKey: 'group-1'
      }
    })

    expect(() => decodeImageUpdateCursor('not valid base64!', FILTERS)).toThrow('cursor is malformed')
    expect(() => decodeImageUpdateCursor(duplicateStatuses, FILTERS)).toThrow('cursor is malformed')
    expect(() => decodeImageUpdateCursor(wrongOrder, FILTERS)).toThrow('cursor is malformed')
  })

  it('rejects obsolete cluster-bearing version-one cursors', () => {
    const obsoleteCursor = encodePayload({
      version: 1,
      reportId: 'report-1',
      cluster: 'in-cluster',
      namespace: 'apps',
      versionStatuses: ['major_behind', 'minor_behind'],
      lastAction: {
        riskRank: 1,
        actionType: 'image_tag_update',
        namespace: 'apps',
        groupKey: 'group-1'
      }
    })

    expect(() => decodeImageUpdateCursor(obsoleteCursor, FILTERS)).toThrow('cursor is malformed')
  })

  it('rejects changed request filters', () => {
    const cursor = encodeImageUpdateCursor('report-1', FILTERS, {
      riskRank: 1,
      actionType: 'manual_review',
      namespace: 'apps',
      groupKey: 'group-1'
    })

    expect(() => decodeImageUpdateCursor(cursor, { ...FILTERS, namespace: null })).toThrow(
      'cursor does not match the requested filters'
    )
    expect(() => decodeImageUpdateCursor(cursor, { ...FILTERS, versionStatuses: ['major_behind'] })).toThrow(
      'cursor does not match the requested filters'
    )
  })
})

function encodePayload(payload: object): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}
