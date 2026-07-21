import { proxyPlatformManagerRequest } from "@/lib/api/platform-manager-proxy"

export const dynamic = "force-dynamic"

// The calling user's tenants (all managed tenants for platform admins);
// answers 404 when PLATFORM_MANAGER_URL is unset.
export async function GET(req: Request) {
  return proxyPlatformManagerRequest(req, "/api/tenants")
}
