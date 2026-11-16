"use client"

import CapabilitiesPage from "@/app/provisioning/components/capabilities-page"
import OfferingList from "@/app/provisioning/components/offering-list"

// The operators running here, each with the smallest manifest this cluster
// would accept at the API version it serves.
export default function OperatorsPage() {
  return (
    <CapabilitiesPage title="Operators" subtitle="Databases and other services this cluster runs operators for. Each sample is sized for trying something out: one replica, a small disk.">
      {({ capabilities }) => (
        <OfferingList
          offerings={capabilities.offerings.filter(o => o.availability.state === "ready")}
          storageClasses={capabilities.storageClasses}
          namespace={capabilities.namespaces[0]?.namespace ?? null}
          sandboxId={capabilities.namespaces[0]?.tenant?.id ?? capabilities.namespaces[0]?.sandbox ?? null}
          verdicts={capabilities.namespaces[0]?.offerings ?? null}
        />
      )}
    </CapabilitiesPage>
  )
}
