"use client"

type Props = {
  tenant: string
  entity: string
}

// Friendly empty state for a selected tenant whose namespaces match nothing
// in the current report.
export default function TenantEmptyState({ tenant, entity }: Props) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl border border-gray-200 bg-white px-5 py-12 text-center">
      <p className="text-sm font-medium text-foreground">
        No {entity} found for tenant <span className="font-mono">{tenant}</span>
      </p>
      <p className="text-sm text-muted-foreground">
        None of this tenant&apos;s namespaces appear in the current report. Use the tenant
        switcher in the sidebar to change scope.
      </p>
    </div>
  )
}
