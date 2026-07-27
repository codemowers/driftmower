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

export class KubeApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "KubeApiError"
    this.status = status
  }
}

export function isInCluster(): boolean {
  return typeof process.env.KUBERNETES_SERVICE_HOST === "string" && process.env.KUBERNETES_SERVICE_HOST !== ""
}

const KUBE_API_HOST = "kubernetes.default.svc"

async function kubeRequestText(path: string, accept: string): Promise<string> {
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443"
  if (!isInCluster()) throw new Error("Not running inside a Kubernetes pod (KUBERNETES_SERVICE_HOST unset)")
  const [token, ca] = await Promise.all([readToken(), readCa()])
  const headers: OutgoingHttpHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: accept,
  }

  return await new Promise<string>((resolve, reject) => {
    const req = request(
      { host: KUBE_API_HOST, port: Number(port), path, method: "GET", headers, ca },
      res => {
        const chunks: Buffer[] = []
        res.on("data", chunk => chunks.push(chunk))
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8")
          if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body)
          } else {
            console.error(`[kube-api] GET ${path} -> ${res.statusCode}: ${body.slice(0, 200)}`)
            reject(new KubeApiError(
              `Kubernetes API ${path} returned ${res.statusCode}: ${body.slice(0, 200)}`,
              res.statusCode ?? 0,
            ))
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

export async function kubeApiGet<T>(path: string): Promise<T> {
  const body = await kubeRequestText(path, "application/json")
  try {
    return JSON.parse(body) as T
  } catch (e) {
    throw new Error(`Kubernetes API ${path} returned non-JSON body: ${(e as Error).message}`)
  }
}

export async function kubeApiGetText(path: string): Promise<string> {
  return await kubeRequestText(path, "text/plain")
}
