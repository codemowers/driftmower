"use client"

type Props = {
  sandboxes: string[]
  entity: string
}

export default function SandboxEmptyState({ sandboxes, entity }: Props) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl border border-gray-200 bg-white px-5 py-12 text-center">
      <p className="text-sm font-medium text-foreground">
        {sandboxes.length === 1 ? (
          <>
            No {entity} found for sandbox <span className="font-mono">{sandboxes[0]}</span>
          </>
        ) : (
          <>No {entity} found for the {sandboxes.length} selected sandboxes</>
        )}
      </p>
      <p className="text-sm text-muted-foreground">
        None of the selected namespaces appear in the current report. Use the sandbox
        switcher in the sidebar to change scope.
      </p>
    </div>
  )
}
