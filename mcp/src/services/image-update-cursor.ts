import { Buffer } from 'node:buffer'
import { z } from 'zod'
import {
  ACTIONABLE_VERSION_STATUSES,
  IMAGE_UPDATE_ACTION_TYPES,
  VERSION_STATUS_RISK_RANK,
  type ActionableVersionStatus,
  type ImageUpdateActionSortKey,
  type ImageUpdateFilters
} from '../domain/image-update-plan.js'

const CURSOR_VERSION = 2
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const MAX_RISK_RANK = Math.max(...Object.values(VERSION_STATUS_RISK_RANK))

const cursorSchema = z
  .object({
    version: z.literal(CURSOR_VERSION),
    reportId: z.string().min(1),
    namespace: z.string().nullable(),
    versionStatuses: z.array(z.enum(ACTIONABLE_VERSION_STATUSES)).min(1),
    lastAction: z
      .object({
        riskRank: z.number().int().min(0).max(MAX_RISK_RANK),
        actionType: z.enum(IMAGE_UPDATE_ACTION_TYPES),
        namespace: z.string(),
        groupKey: z.string().min(1)
      })
      .strict()
  })
  .strict()

export interface ImageUpdateCursorPayload {
  version: 2
  reportId: string
  namespace: string | null
  versionStatuses: ActionableVersionStatus[]
  lastAction: ImageUpdateActionSortKey
}

export function encodeImageUpdateCursor(
  reportId: string,
  filters: ImageUpdateFilters,
  lastAction: ImageUpdateActionSortKey
): string {
  const payload: ImageUpdateCursorPayload = {
    version: CURSOR_VERSION,
    reportId,
    namespace: filters.namespace,
    versionStatuses: filters.versionStatuses,
    lastAction
  }

  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

export function decodeImageUpdateCursor(
  value: string,
  filters: ImageUpdateFilters
): ImageUpdateCursorPayload {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new Error('cursor is malformed')
  }

  const payload = parseCursorPayload(value)

  if (!sameFilters(payload, filters)) {
    throw new Error('cursor does not match the requested filters')
  }

  return payload
}

function parseCursorPayload(value: string): ImageUpdateCursorPayload {
  try {
    const decodedValue: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const result = cursorSchema.safeParse(decodedValue)

    if (!result.success || !hasNormalizedStatuses(result.data.versionStatuses)) {
      throw new Error('invalid cursor payload')
    }

    return result.data
  } catch {
    throw new Error('cursor is malformed')
  }
}

function sameFilters(payload: ImageUpdateCursorPayload, filters: ImageUpdateFilters): boolean {
  return (
    payload.namespace === filters.namespace &&
    payload.versionStatuses.length === filters.versionStatuses.length &&
    payload.versionStatuses.every((status, index) => status === filters.versionStatuses[index])
  )
}

function hasNormalizedStatuses(statuses: ActionableVersionStatus[]): boolean {
  const expected = ACTIONABLE_VERSION_STATUSES.filter(status => statuses.includes(status))

  return expected.length === statuses.length && expected.every((status, index) => status === statuses[index])
}
