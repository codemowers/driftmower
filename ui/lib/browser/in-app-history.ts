let firstPathname: string | null = null
let navigated = false

export function noteNavigation(pathname: string): void {
  if (firstPathname === null) firstPathname = pathname
  else if (pathname !== firstPathname) navigated = true
}

export function hasInAppHistory(): boolean {
  return navigated
}
