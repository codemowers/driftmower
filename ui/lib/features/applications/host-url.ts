export function hostOf(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}
