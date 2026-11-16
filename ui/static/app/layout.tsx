import { Inter, JetBrains_Mono } from "next/font/google"
import "../../app/globals.css"
const inter = Inter({ variable: "--font-sans", subsets: ["latin"] })
const jetbrainsMono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"] })
export const metadata = { title: "Driftmower" }
// The desktop app's Chrome window paints its title bar in this colour:
// Adwaita's header bar, so it sits among GNOME's own windows.
export const viewport = { themeColor: [
  { media: "(prefers-color-scheme: light)", color: "#ebebeb" },
  { media: "(prefers-color-scheme: dark)", color: "#303030" },
] }
export default function Layout({children}: {children: React.ReactNode}) {
  return <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} h-full`}><body className="h-screen overflow-hidden">{children}</body></html>
}
