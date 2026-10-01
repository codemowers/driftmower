"use client"

import { useEffect } from "react"
import { Inter, JetBrains_Mono } from "next/font/google"
import { Button } from "@/components/ui/button"
import DriftmowerLogo from "./components/core/driftmower-logo"
import ErrorCard from "./components/error-card"
import "./globals.css"

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
})

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
})

type RootError = Error & { digest?: string }

export default function GlobalError({ error }: { error: RootError }) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} h-full`}>
      <body className="h-full bg-gray-50">
        <title>Driftmower</title>
        <div className="fixed top-4.5 left-5">
          <DriftmowerLogo />
        </div>
        <div className="flex min-h-full items-center justify-center px-4 py-20">
          <ErrorCard
            tone="error"
            title="Driftmower couldn't load"
            message="Reload the page. If it keeps happening, try again in a minute."
            error={error}
          >
            <Button onClick={() => window.location.reload()}>Reload</Button>
          </ErrorCard>
        </div>
      </body>
    </html>
  )
}
