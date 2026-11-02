import { redirect } from "next/navigation"

export default async function RootPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") params.set(key, value)
    else if (Array.isArray(value) && value[0] !== undefined) params.set(key, value[0])
  }

  const query = params.toString()
  redirect(query ? `/executive-summary?${query}` : "/executive-summary")
}
