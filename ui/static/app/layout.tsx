import { Inter, JetBrains_Mono } from "next/font/google"
import "../../app/globals.css"
const inter = Inter({ variable: "--font-sans", subsets: ["latin"] })
const jetbrainsMono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"] })
export default function Layout({children}: {children: React.ReactNode}) {
  return <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} h-full`}><body className="h-screen overflow-hidden">{children}</body></html>
}
