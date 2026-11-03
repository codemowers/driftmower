import { fetchRegisteredApps } from "@/lib/features/applications/registered"

export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

export async function GET() {
  const registered = await fetchRegisteredApps()

  switch (registered.state) {
    case "ok":
      return Response.json({ apps: registered.apps }, { headers: NO_STORE })
    case "scope-not-configured":
      return Response.json(
        { error: "applications scope not configured" },
        { status: 501, headers: { ...NO_STORE, "x-scope-not-configured": "1" } },
      )
    case "unauthenticated":
      return Response.json({ error: "not authenticated" }, { status: 401, headers: NO_STORE })
    case "forbidden":
      return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE })
    default:
      return Response.json({ error: registered.message }, { status: 502, headers: NO_STORE })
  }
}
