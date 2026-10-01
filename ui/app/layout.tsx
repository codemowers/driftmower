import type { Metadata } from "next"
import { Suspense } from "react"
import { Inter, JetBrains_Mono } from "next/font/google"
import { headers } from "next/headers"
import NavBar from "./components/core/nav-bar"
import RefreshingOverlay from "./components/core/refreshing-overlay"
import ClusterInit from "./components/cluster-init"
import SandboxContextInit from "./components/sandbox-context-init"
import FeatureFlagsInit from "./components/feature-flags-init"
import { workloadRestartEnabled } from "@/lib/server/restart-workload"
import { isLlmConfigured } from "@/lib/llm"
import { getSession } from "@/lib/auth/session"
import { callerSeesClusterWideViews } from "@/lib/server/sandbox-scope-filter"
import { STRIP_DZ_INJECTED } from "@/lib/browser/strip-dz-injected"
import { TooltipProvider } from "@/components/ui/tooltip"
import "./globals.css"

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
})

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "Driftmower",
  description: "Monitor container image drift across your cluster",
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getSession()
  const nonce = (await headers()).get("x-nonce") ?? undefined
  const claims = session.accessToken ? session.claims : undefined
  const seesClusterWideViews = claims ? await callerSeesClusterWideViews() : false

  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: STRIP_DZ_INJECTED }}/>
      </head>

      <body className="flex h-screen min-h-0 flex-col overflow-hidden">
        {claims ? (
          <>
            <Suspense><ClusterInit /></Suspense>
            <Suspense><SandboxContextInit /></Suspense>
            <FeatureFlagsInit workloadRestart={workloadRestartEnabled()} llm={isLlmConfigured()} />
            <RefreshingOverlay />

            <TooltipProvider>
              <div className="flex min-h-0 flex-1 flex-row">
                <aside className="flex h-full min-h-0 shrink-0 flex-col border-r border-border bg-background">
                  <NavBar claims={claims} seesClusterWideViews={seesClusterWideViews} />
                </aside>
                <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
                  <div className="mx-auto w-full max-w-[1400px] min-h-full">
                    {children}
                  </div>
                </div>
              </div>
            </TooltipProvider>
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {children}
          </div>
        )}
      </body>
    </html>
  )
}
