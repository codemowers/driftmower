"use client"

import { useEffect } from "react"
import PrefetchLink from "@/app/components/prefetch-link"
import { useParams } from "next/navigation"
import { Check, Package } from "lucide-react"
import { Button } from "@/components/ui/button"
import Breadcrumbs from "../../components/breadcrumbs"
import { ValuePill } from "../components/overflow-pills"
import KubeconfigPanel from "../kubeconfig-panel"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { cn } from "@/lib/utils/cn"
import { hydrateSandboxContext, toggleSandbox, useSandboxContext } from "@/lib/tenancy/sandbox-context"
import LoadingLine from "@/app/components/loading-line"
import AccessCard from "@/app/provisioning/components/access-card"
import HostCard from "@/app/provisioning/components/host-card"
import Section from "@/app/provisioning/components/section"
import { useCapabilities } from "@/lib/features/provisioning/use-capabilities"

export default function SandboxDetailPage() {
  const params = useParams<{ sandbox: string }>()
  const id = decodeURIComponent(params.sandbox)
  const hydrated = useSandboxContext(s => s.hydrated)
  const sandboxes = useSandboxContext(s => s.sandboxes)
  const selectedSandboxes = useSandboxContext(s => s.selectedSandboxes)
  const { linkTo } = useContextHref()

  useEffect(() => {
    hydrateSandboxContext()
  }, [])

  const sandbox = sandboxes.find(s => s.sandbox === id)
  const breadcrumbs = [{ label: "Sandboxes", href: linkTo("/sandboxes", { drop: ["focus"] }) }, { label: id }]

  if (!hydrated) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
          <LoadingLine loading="sandbox" />
        </main>
      </div>
    )
  }

  if (!sandbox) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
          <Breadcrumbs items={breadcrumbs} />
          <p className="text-sm text-muted-foreground">Sandbox not found</p>
        </main>
      </div>
    )
  }

  const isSelected = selectedSandboxes.includes(sandbox.sandbox)

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        <header className="flex flex-col gap-4">
          <Breadcrumbs items={breadcrumbs} />

          <div className="flex items-start justify-between gap-8">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <Package className="size-6 shrink-0 text-brand-icon" aria-hidden />
                <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
                  {sandbox.sandbox}
                </h1>
                <span className="rounded-full bg-muted px-2.5 py-1 font-mono text-xs text-muted-foreground">
                  {sandbox.stackChannel}
                </span>
              </div>
              {sandbox.creator && (
                <p className="text-sm text-muted-foreground">Created by {sandbox.creator}</p>
              )}
            </div>
            <div className="shrink-0 p-1">
            </div>
          </div>

          <div className="flex items-start justify-between gap-8 border-b border-gray-200 pb-5">
            <div className="flex flex-wrap gap-x-10 gap-y-4">
              <div className="flex flex-col gap-1.5">
                <p className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Namespace
                </p>
                <div className="flex">
                  <ValuePill value={sandbox.namespace} copyable />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <p className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Owners
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {sandbox.owners.length === 0 ? (
                    <span className="text-sm text-gray-400">&mdash;</span>
                  ) : (
                    sandbox.owners.map(owner => (
                      <span
                        key={owner}
                        className="rounded-full bg-muted px-2.5 py-1 font-mono text-xs text-muted-foreground"
                      >
                        {owner}
                      </span>
                    ))
                  )}
                </div>
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={isSelected}
              onClick={() => toggleSandbox(sandbox.sandbox)}
              className={cn(
                "w-[104px] shrink-0 justify-center",
                isSelected && "border-brand text-brand hover:bg-background hover:text-brand",
              )}
            >
              {isSelected ? <Check aria-hidden /> : <Package aria-hidden />}
              {isSelected ? "Selected" : "Select"}
            </Button>
          </div>
        </header>

        <KubeconfigPanel key={sandbox.sandbox} sandbox={sandbox.sandbox} />

        <SandboxCapabilities namespace={sandbox.namespace} />

        {sandbox.registryEnabled && (
          <p className="text-sm text-muted-foreground">
            This sandbox runs its own container registry. Its{" "}
            <PrefetchLink
              href={linkTo("/registry", { drop: ["focus"] })}
              className="text-brand-label underline decoration-dotted underline-offset-2 hover:text-brand"
            >
              Container registry
            </PrefetchLink>{" "}
            page has the <code className="font-mono text-xs">docker login</code>, a ready{" "}
            <code className="font-mono text-xs">skaffold.env</code> and a pull example.
          </p>
        )}
      </main>
    </div>
  )
}

// What you may do in the sandbox's namespace and the hostnames it may claim.
function SandboxCapabilities({ namespace }: { namespace: string }) {
  const state = useCapabilities([namespace])
  if (state.status === "loading") return <LoadingLine loading="sandbox access" />
  if (state.status !== "ready") return null
  return (
    <>
      <Section title="Your access" hint="Asked of the cluster as you, for every resource type it serves. Admission policies can still reject an apply these permissions allow.">
        <AccessCard namespaces={state.capabilities.namespaces} />
      </Section>
      <Section title="Hostnames" hint="The ingress controller is shared, so the hostname this sandbox may claim is anchored on its namespace and enforced on admission.">
        <HostCard ingress={state.capabilities.ingress} />
      </Section>
    </>
  )
}
