import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import NavBar from "./components/nav-bar";
import RefreshingOverlay from "./components/refreshing-overlay";
import ClusterInit from "./components/cluster-init";
import { STRIP_DZ_INJECTED } from "@/lib/browser/strip-dz-injected";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Driftmower",
  description: "Monitor container image drift across your cluster",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: STRIP_DZ_INJECTED }}/>
      </head>

      <body className="flex h-screen min-h-0 flex-col overflow-hidden">
        <ClusterInit />
        <RefreshingOverlay />

        <TooltipProvider>
          <div className="flex min-h-0 flex-1 flex-row">
            <aside className="flex h-full min-h-0 shrink-0 flex-col border-r border-border bg-background">
              <NavBar />
            </aside>
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
              <div className="mx-auto w-full max-w-[1400px] min-h-full">
                {children}
              </div>
            </div>
          </div>
        </TooltipProvider>
      </body>
    </html>
  );
}
