import { readFile } from "node:fs/promises"
import { request } from "node:https"
import type { OutgoingHttpHeaders } from "node:http"

const TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"
const CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"

let cachedToken: string | null = null
let cachedCa: Buffer | null = null

async function readToken(): Promise<string> {
  if (cachedToken !== null) return cachedToken
  cachedToken = (await readFile(TOKEN_PATH, "utf8")).trim()
  return cachedToken
}

async function readCa(): Promise<Buffer> {
  if (cachedCa !== null) return cachedCa
  cachedCa = await readFile(CA_PATH)
  return cachedCa
}

export function isInCluster(): boolean {
  return typeof process.env.KUBERNETES_SERVICE_HOST === "string" && process.env.KUBERNETES_SERVICE_HOST !== ""
}

export async function kubeApiGet<T>(path: string): Promise<T> {
  const host = process.env.KUBERNETES_SERVICE_HOST
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443"
  if (!host) throw new Error("Not running inside a Kubernetes pod (KUBERNETES_SERVICE_HOST unset)")
  const [token, ca] = await Promise.all([readToken(), readCa()])
  const headers: OutgoingHttpHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  }

  return await new Promise<T>((resolve, reject) => {
    const req = request(
      { host, port: Number(port), path, method: "GET", headers, ca },
      res => {
        const chunks: Buffer[] = []
        res.on("data", chunk => chunks.push(chunk))
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8")
          if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(body) as T)
            } catch (e) {
              reject(new Error(`Kubernetes API ${path} returned non-JSON body: ${(e as Error).message}`))
            }
          } else {
            console.error(`[kube-api] GET ${path} -> ${res.statusCode}: ${body.slice(0, 200)}`)
            reject(new Error(`Kubernetes API ${path} returned ${res.statusCode}: ${body.slice(0, 200)}`))
          }
        })
      },
    )
    req.on("error", e => {
      console.error(`[kube-api] GET ${path} -> request error:`, (e as Error).message)
      reject(e)
    })
    req.end()
  })
}
