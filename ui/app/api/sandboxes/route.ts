import { proxyPlatformManagerRequest, SANDBOXES_PATH } from "@/lib/server/platform-manager-proxy"

export const dynamic = "force-dynamic"

// The calling user's sandboxes (every managed sandbox for platform admins);
// answers 404 when PLATFORM_MANAGER_URL is unset.
export async function GET(req: Request) {
  return proxyPlatformManagerRequest(req, SANDBOXES_PATH)
}
