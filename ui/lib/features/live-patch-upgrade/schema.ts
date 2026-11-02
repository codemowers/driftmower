import { z } from "zod"

const managerSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("helm"), namespace: z.string(), release: z.string() }),
  z.looseObject({ kind: z.literal("argo"), app: z.string() }),
  z.looseObject({ kind: z.literal("standalone"), workloadKind: z.string(), namespace: z.string(), name: z.string(), container: z.string() }),
  z.looseObject({ kind: z.literal("operator"), workloadKind: z.string(), apiGroup: z.string(), namespace: z.string(), name: z.string() }),
])

const factsSchema = z.looseObject({
  kind: z.literal("update-image"),
  repository: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  drift: z.literal("patch"),
  manager: managerSchema,
})

const targetSchema = z.object({
  namespace: z.string().min(1),
  kind: z.string().min(1),
  name: z.string().min(1),
  uid: z.string(),
})

export const livePatchUpgradeRequestSchema = z.object({
  facts: factsSchema,
  target: targetSchema,
  dryRun: z.boolean().optional(),
})
