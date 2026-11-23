"use client"
import { ICONS } from "@/app/components/layout/icons"

import CapabilitiesPage from "@/app/provisioning/components/capabilities-page"
import PodSecurityCard from "@/app/provisioning/components/pod-security-card"
import PolicyTable from "./policy-table"

// Checked after your permissions: a policy rejects an invalid apply with an
// explanation, even when your role allows it, and a mutating one rewrites it.
export default function AdmissionPoliciesPage() {
  return (
    <CapabilitiesPage icon={ICONS.admissionPolicies} title="Admission policies" subtitle="Checked after your permissions: validating policies reject an invalid apply even when your role allows it, mutating ones rewrite it on the way in.">
      {({ capabilities }) => (
        <div className="flex flex-col gap-4">
          {/* Pod Security first: the API server enforces it rather than a
              policy object, so it appears in no listing below, and it is the
              rule most likely to reject a first Pod. */}
          <PodSecurityCard namespaces={capabilities.namespaces} />
          <PolicyTable />
        </div>
      )}
    </CapabilitiesPage>
  )
}
