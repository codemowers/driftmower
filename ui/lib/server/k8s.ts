import "server-only"

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
const TEXT_ACCEPT = "text/plain, application/json"
const STATUS_MESSAGE_MAX = 300

function statusMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { kind?: string; message?: string }
    if (parsed.kind === "Status" && typeof parsed.message === "string") return parsed.message.slice(0, STATUS_MESSAGE_MAX)
  } catch {}
  return body.replace(/\s+/g, " ").slice(0, STATUS_MESSAGE_MAX)
}

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
            const detail = statusMessage(body)
            console.error(`[kube-api] GET ${path} -> ${res.statusCode}: ${detail}`)
            reject(new KubeApiError(
              `Kubernetes API ${path} returned ${res.statusCode}: ${detail}`,
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

async function kubeRequestWithTokenRefresh(path: string, accept: string): Promise<string> {
  try {
    return await kubeRequestText(path, accept)
  } catch (e) {
    if (!(e instanceof KubeApiError) || e.status !== 401) throw e
    cachedToken = null
    return await kubeRequestText(path, accept)
  }
}

export async function kubeApiGet<T>(path: string): Promise<T> {
  const body = await kubeRequestWithTokenRefresh(path, "application/json")
  try {
    return JSON.parse(body) as T
  } catch (e) {
    throw new Error(`Kubernetes API ${path} returned non-JSON body: ${(e as Error).message}`)
  }
}

export async function kubeApiGetText(path: string): Promise<string> {
  return await kubeRequestWithTokenRefresh(path, TEXT_ACCEPT)
}
