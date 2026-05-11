export const dynamic = "force-dynamic"

export async function GET() {
  return Response.json(
    {
      backendPublicUrl: process.env.BACKEND_PUBLIC_URL ?? "",
      netstatdPublicUrl: process.env.NETSTATD_PUBLIC_URL ?? "",
    },
    { headers: { "Cache-Control": "no-store" } },
  )
}
