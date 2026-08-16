import { z } from 'zod'

const releaseInfoSchema = z.object({
  name: z.string().optional(),
  namespace: z.string().optional(),
  chartName: z.string().optional(),
  chartVersion: z.string().optional(),
  chartAppVersion: z.string().optional(),
  latestChartTag: z.string().optional()
})

type PersistedReleaseInfo = z.infer<typeof releaseInfoSchema>

export function parseReleaseInfo(value: string | null): PersistedReleaseInfo | null {
  if (value === null) {
    return null
  }

  try {
    const result = releaseInfoSchema.safeParse(JSON.parse(value))

    return result.success ? result.data : null
  } catch {
    return null
  }
}
