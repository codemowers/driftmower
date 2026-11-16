"use client"

import CapabilitiesPage from "@/app/provisioning/components/capabilities-page"
import StorageList from "@/app/provisioning/components/storage-list"

export default function StorageClassesPage() {
  return (
    <CapabilitiesPage title="Storage classes" subtitle="Where claims can be provisioned, and whether their data survives losing a node.">
      {({ capabilities }) => <StorageList classes={capabilities.storageClasses} />}
    </CapabilitiesPage>
  )
}
