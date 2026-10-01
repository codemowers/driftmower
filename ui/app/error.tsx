"use client"

import { useEffect } from "react"
import PrefetchLink from "@/app/components/prefetch-link"
import { usePathname, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { hasInAppHistory } from "@/lib/browser/in-app-history"
import { useContextHref } from "@/lib/hooks/use-context-href"
import ErrorCard from "./components/error-card"

type RouteError = Error & { digest?: string }

function isChunkLoadError(error: RouteError): boolean {
  return error.name === "ChunkLoadError" || /Failed to load chunk|Loading (css )?chunk .* failed/.test(error.message)
}

function parentPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean)
  const [section] = segments
  if (section === "yaml") return null
  if (section === "container-images") return "/container-images"
  if (section === "topmost-owners" && segments[2] === "images") return `/${segments.slice(0, 2).join("/")}`
  return `/${segments.slice(0, -1).join("/")}`
}

function GoBack({ pathname }: { pathname: string }) {
  const router = useRouter()
  const { linkTo } = useContextHref()
  const parent = parentPath(pathname)

  if (hasInAppHistory()) {
    return <Button variant="outline" onClick={() => router.back()}>Go back</Button>
  }
  if (!parent) return null
  return (
    <Button variant="outline" asChild>
      <PrefetchLink href={linkTo(parent)}>Go back</PrefetchLink>
    </Button>
  )
}

export default function RouteErrorPage({ error }: { error: RouteError }) {
  const pathname = usePathname()
  const isDetailPage = pathname.split("/").filter(Boolean).length > 1

  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        {isChunkLoadError(error) ? (
          <ErrorCard tone="update" title="Driftmower was updated" message="Reload to get the latest version." error={error}>
            <Button onClick={() => window.location.reload()}>Reload</Button>
          </ErrorCard>
        ) : (
          <ErrorCard tone="error" title="This page couldn't load" message="Try again, or pick another page from the sidebar." error={error}>
            <Button onClick={() => window.location.reload()}>Try again</Button>
            {isDetailPage && <GoBack pathname={pathname} />}
          </ErrorCard>
        )}
      </main>
    </div>
  )
}
