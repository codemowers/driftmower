"use client"

type Props = {
  tenants: string[]
  entity: string
}

export default function TenantEmptyState({ tenants, entity }: Props) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl border border-gray-200 bg-white px-5 py-12 text-center">
      <p className="text-sm font-medium text-foreground">
        {tenants.length === 1 ? (
          <>
            No {entity} found for tenant <span className="font-mono">{tenants[0]}</span>
          </>
        ) : (
          <>No {entity} found for the {tenants.length} selected tenants</>
        )}
      </p>
      <p className="text-sm text-muted-foreground">
        None of the selected namespaces appear in the current report. Use the tenant
        switcher in the sidebar to change scope.
      </p>
    </div>
  )
}
