"use client"
import { createContext, useContext, useSyncExternalStore } from "react"
export const Params = createContext<Record<string, string | string[]>>({})
const subscribe = (callback: () => void) => { window.addEventListener("popstate", callback); return () => window.removeEventListener("popstate", callback) }
export function navigate(href: string, replace = false) {
  const url = new URL(href, location.href)
  if (url.origin !== location.origin) { location.assign(url.href); return }
  history[replace ? "replaceState" : "pushState"](null, "", url)
  window.dispatchEvent(new PopStateEvent("popstate"))
}
export function usePathname() { return useSyncExternalStore(subscribe, () => location.pathname, () => "/") }
export function useSearchParams() { const query = useSyncExternalStore(subscribe, () => location.search, () => ""); return new URLSearchParams(query) }
export function useParams<T = Record<string, string | string[]>>() { return useContext(Params) as T }
export function useRouter() { return { push: navigate, replace: (href: string) => navigate(href, true), back: () => history.back(), forward: () => history.forward(), refresh: () => window.dispatchEvent(new PopStateEvent("popstate")), prefetch: (_href: string, _options?: unknown) => {} } }
export function redirect(url: string) { navigate(url,true) }
