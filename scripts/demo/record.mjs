#!/usr/bin/env node
// Records a narrated Driftmower dashboard tour with the locally installed
// Google Chrome. See README.md; demo.sh wires up TTS from a cluster.
import { chromium } from "playwright-core"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { tour } from "./tour.mjs"

const here = path.dirname(new URL(import.meta.url).pathname)
const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string", default: process.env.DRIFTMOWER_DASHBOARD_URL },
    profile: { type: "string", default: process.env.DRIFTMOWER_DEMO_PROFILE || path.join(os.homedir(), ".cache/driftmower-demo/chrome-profile") },
    "chrome-profile": { type: "string", default: process.env.DEMO_CHROME_PROFILE },
    "chrome-user-data": { type: "string", default: path.join(os.homedir(), ".config/google-chrome") },
    out: { type: "string", default: path.join(here, "out") },
    size: { type: "string", default: "1920x1080" },
    theme: { type: "string", default: "light" },
    voice: { type: "string", default: process.env.DEMO_TTS_VOICE || "en_US-lessac-medium" },
    // Speech speed-up applied to each clip (ffmpeg atempo), for a brisk pace.
    tempo: { type: "string", default: "1.12" },
    headless: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
})
const mode = positionals[0] || "record"
if (opt.help || !opt.url || !["login", "record"].includes(mode)) {
  console.error(`usage: record.mjs [login|record] --url https://dashboard.example [--chrome-profile Default] [--size 1920x1080] [--theme light|dark] [--headless]
  --chrome-profile  existing Chrome profile (directory or display name) whose sign-ins are copied for each run
  login   without --chrome-profile: open a separate demo profile so you can sign in once
  record  play tour.mjs, record video and narration, write out/driftmower-demo.mp4
TTS narration is used when DEMO_TTS_URL (and optionally DEMO_TTS_TOKEN) is set.`)
  process.exit(opt.help ? 0 : 2)
}
const origin = new URL(opt.url).origin
const [width, height] = opt.size.split("x").map(Number)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Chrome refuses automation of its default user-data directory and locks a
// profile while it runs, so an existing profile's sign-ins are copied into a
// private user-data directory on every run. Cookies stay encrypted with the
// same OS keyring key, which is why Playwright's mock keychain is disabled.
const launchExtras = { args: [], ignoreDefaultArgs: [] }
if (opt["chrome-profile"]) {
  const source = opt["chrome-user-data"]
  const state = JSON.parse(await readFile(path.join(source, "Local State"), "utf8"))
  const profiles = state.profile?.info_cache ?? {}
  const wanted = opt["chrome-profile"]
  const dir = profiles[wanted] ? wanted : Object.keys(profiles).find(key => profiles[key].name === wanted)
  if (!dir) throw new Error(`Chrome profile "${wanted}" not found; have ${Object.entries(profiles).map(([k, v]) => `${k} (${v.name})`).join(", ")}`)
  const target = path.join(os.homedir(), ".cache/driftmower-demo/from-chrome")
  await rm(target, { recursive: true, force: true })
  await mkdir(path.join(target, dir), { recursive: true })
  await cp(path.join(source, "Local State"), path.join(target, "Local State"))
  for (const item of ["Cookies", "Cookies-journal", "Local Storage", "Preferences"]) {
    const from = path.join(source, dir, item)
    if (existsSync(from)) await cp(from, path.join(target, dir, item), { recursive: true })
  }
  opt.profile = target
  launchExtras.args.push(`--profile-directory=${dir}`)
  launchExtras.ignoreDefaultArgs.push("--password-store=basic", "--use-mock-keychain")
  console.log(`Using sign-ins from Chrome profile ${dir} (${profiles[dir].name})`)
}

if (mode === "login") {
  await mkdir(opt.profile, { recursive: true })
  const context = await chromium.launchPersistentContext(opt.profile, { channel: "chrome", headless: false, viewport: null, ...launchExtras })
  const page = context.pages()[0] ?? await context.newPage()
  await page.goto(new URL("/executive-summary", origin).href)
  console.log(`Sign in to ${origin} in the opened window, check the dashboard loads, then close the window.`)
  await new Promise(resolve => context.on("close", resolve))
  process.exit(0)
}

// ---- Narration -----------------------------------------------------------

function wavSeconds(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("TTS did not return a WAV file")
  let byteRate = 0
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString("ascii", at, at + 4), size = buf.readUInt32LE(at + 4)
    if (id === "fmt ") byteRate = buf.readUInt32LE(at + 16)
    if (id === "data") return Math.min(size, buf.length - at - 8) / byteRate
    at += 8 + size + (size & 1)
  }
  throw new Error("WAV has no data chunk")
}

async function synthesize(text, cacheDir) {
  const key = createHash("sha256").update(`${opt.voice}\n${text}`).digest("hex").slice(0, 16)
  const raw = path.join(cacheDir, `${key}.wav`)
  const file = Number(opt.tempo) === 1 ? raw : path.join(cacheDir, `${key}-x${opt.tempo}.wav`)
  if (!existsSync(raw)) {
    const headers = { "content-type": "application/json" }
    if (process.env.DEMO_TTS_TOKEN) headers.authorization = `Bearer ${process.env.DEMO_TTS_TOKEN}`
    const res = await fetch(new URL("/v1/audio/speech", process.env.DEMO_TTS_URL), {
      method: "POST", headers, body: JSON.stringify({ input: text, voice: opt.voice, response_format: "wav" }),
    })
    if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`)
    await writeFile(raw, Buffer.from(await res.arrayBuffer()))
  }
  if (!existsSync(file)) {
    const ff = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-filter:a", `atempo=${opt.tempo}`, file], { stdio: "inherit" })
    if (ff.status !== 0) throw new Error(`ffmpeg atempo failed for ${raw}`)
  }
  return { file, seconds: wavSeconds(await readFile(file)) }
}

await mkdir(opt.out, { recursive: true })
const clips = new Map()
if (process.env.DEMO_TTS_URL) {
  const cacheDir = path.join(opt.out, "tts-cache")
  await mkdir(cacheDir, { recursive: true })
  for (const [i, step] of tour.entries()) {
    if (!step.say) continue
    clips.set(i, await synthesize(step.say, cacheDir))
    process.stdout.write(`\rnarration ${clips.size}/${tour.filter(s => s.say).length}`)
  }
  console.log()
} else {
  console.log("DEMO_TTS_URL not set: recording without narration")
}

// ---- Overlay: visible cursor and lower-third captions ---------------------

function overlay(dashboardOrigin) {
  if (location.origin !== dashboardOrigin) return
  const install = () => {
    const style = document.createElement("style")
    style.textContent = `
      #demo-cursor{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:transform 40ms linear}
      #demo-cursor svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));transition:transform .12s}
      #demo-cursor.down svg{transform:scale(.8)}
      #demo-caption{position:fixed;left:50%;bottom:48px;z-index:2147483646;pointer-events:none;transform:translateX(-50%);
        max-width:70vw;padding:14px 28px;border-radius:12px;background:rgba(15,23,42,.86);color:#fff;
        font:600 28px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.01em;opacity:0;transition:opacity .35s}
      #demo-caption.on{opacity:1}`
    const cursor = document.createElement("div")
    cursor.id = "demo-cursor"
    cursor.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l15 11-6.6 1.2L16 21l-3 1.3-3.6-6.8L4 20z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>'
    const caption = document.createElement("div")
    caption.id = "demo-caption"
    document.documentElement.append(style, cursor, caption)
    addEventListener("mousemove", e => { cursor.style.transform = `translate(${e.clientX - 4}px,${e.clientY - 2}px)` }, true)
    addEventListener("mousedown", () => cursor.classList.add("down"), true)
    addEventListener("mouseup", () => cursor.classList.remove("down"), true)
    window.__demoCaption = text => {
      caption.classList.remove("on")
      if (!text) return
      setTimeout(() => { caption.textContent = text; caption.classList.add("on") }, 200)
    }
  }
  if (document.documentElement) install(); else addEventListener("DOMContentLoaded", install)
}

// ---- Recording ------------------------------------------------------------

const rawDir = path.join(opt.out, "raw")
const context = await chromium.launchPersistentContext(opt.profile, {
  channel: "chrome",
  headless: opt.headless,
  viewport: { width, height },
  deviceScaleFactor: 1,
  colorScheme: opt.theme,
  recordVideo: { dir: rawDir, size: { width, height } },
  args: [`--window-size=${width},${height + 140}`, ...launchExtras.args],
  ignoreDefaultArgs: launchExtras.ignoreDefaultArgs,
})
const t0 = Date.now()
const now = () => (Date.now() - t0) / 1000
await context.addInitScript(overlay, origin)
const page = context.pages()[0] ?? await context.newPage()
const mouse = { x: width / 2, y: height / 2 }

// The dashboard polls continuously, so the network rarely goes idle; cap the
// wait instead of letting every shot run into a long timeout.
async function settle() {
  await page.waitForLoadState("networkidle", { timeout: 2_500 }).catch(() => {})
  await sleep(500)
}

async function glideTo(x, y) {
  const distance = Math.hypot(x - mouse.x, y - mouse.y)
  await page.mouse.move(x, y, { steps: Math.max(8, Math.round(distance / 40)) })
  Object.assign(mouse, { x, y })
}

async function clickLocator(locator) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (!box) throw new Error("link is not visible")
  await glideTo(box.x + Math.min(box.width / 2, 60), box.y + box.height / 2)
  await sleep(120)
  const before = page.url()
  await page.mouse.down(); await sleep(70); await page.mouse.up()
  await page.waitForURL(url => url.href !== before, { timeout: 4_000 }).catch(() => {})
}

async function smoothScroll(pixels, seconds) {
  if (!pixels) return
  await glideTo(width * 0.6, height * 0.55)
  const ticks = Math.max(1, Math.round(seconds * 20))
  for (let i = 0; i < ticks; i++) { await page.mouse.wheel(0, pixels / ticks); await sleep(50) }
}

console.log(`Opening ${origin} (sign in if the profile has no session; waiting up to 3 minutes)`)
await page.goto(new URL("/executive-summary", origin).href)
await page.waitForURL(url => url.origin === origin && !url.pathname.startsWith("/callback"), { timeout: 180_000 })
await page.locator('nav[aria-label="Main navigation"]').waitFor({ timeout: 180_000 })
await settle()

const tourStart = Math.max(0, now() - 0.3)
const timeline = []
for (const [i, step] of tour.entries()) {
  try {
    if (step.nav) {
      const link = page.locator(`nav[aria-label="Main navigation"] a[aria-label="${step.nav}"]`)
      if (await link.count() === 0) throw new Error(`no sidebar entry "${step.nav}"`)
      // Already on that page (the opening shot): narrate immediately.
      if (await link.first().getAttribute("aria-current") !== "page") await clickLocator(link.first())
    } else if (step.open) {
      const link = page.locator(step.open).filter({ visible: true })
      if (await link.count() === 0) throw new Error(`no link matches ${step.open}`)
      await clickLocator(link.first())
    }
  } catch (error) {
    console.warn(`skip ${i + 1} (${step.caption ?? step.nav}): ${error.message}`)
    continue
  }
  await settle()
  const start = now()
  await page.evaluate(text => window.__demoCaption?.(text), step.caption ?? "")
  const clip = clips.get(i)
  const hold = Math.max(step.hold ?? 3, clip ? clip.seconds + 0.3 : 0)
  console.log(`${String(i + 1).padStart(2)}. ${step.caption ?? step.nav} (${hold.toFixed(1)}s)`)
  await sleep(hold * 0.2 * 1000)
  await smoothScroll(step.scroll ?? 0, Math.min(2, hold * 0.35))
  await sleep(Math.max(0, start + hold - now()) * 1000)
  if (step.scroll) await page.mouse.wheel(0, -(step.scroll * 2))
  timeline.push({ start, end: now(), caption: step.caption, say: step.say, clip })
}
await page.evaluate(() => window.__demoCaption?.(""))
await sleep(1200)
const tourEnd = now()
// A persistent context's video is finalized on close; saveAs no longer works then.
const rawVideo = await page.video().path()
await context.close()

// ---- Assembly -------------------------------------------------------------

const srt = timeline.filter(t => t.say).map((t, n) => {
  const ts = s => new Date(Math.max(0, s - tourStart) * 1000).toISOString().slice(11, 23).replace(".", ",")
  return `${n + 1}\n${ts(t.start)} --> ${ts(t.end)}\n${t.say}\n`
}).join("\n")
await writeFile(path.join(opt.out, "driftmower-demo.srt"), srt)

const output = path.join(opt.out, "driftmower-demo.mp4")
const voiced = timeline.filter(t => t.clip)
const ffArgs = ["-y", "-loglevel", "error", "-ss", tourStart.toFixed(3), "-t", (tourEnd - tourStart).toFixed(3), "-i", rawVideo]
for (const t of voiced) ffArgs.push("-i", t.clip.file)
if (voiced.length) {
  const delays = voiced.map((t, n) => `[${n + 1}:a]aresample=48000,adelay=${Math.round((t.start - tourStart) * 1000)}:all=1[a${n}]`)
  ffArgs.push("-filter_complex", `${delays.join(";")};${voiced.map((_, n) => `[a${n}]`).join("")}amix=inputs=${voiced.length}:normalize=0,apad[aout]`,
    "-map", "0:v", "-map", "[aout]", "-c:a", "aac", "-b:a", "160k", "-shortest")
}
ffArgs.push("-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output)
const ff = spawnSync("ffmpeg", ffArgs, { stdio: "inherit" })
if (ff.status !== 0) { console.error(`ffmpeg failed; raw recording kept at ${rawVideo}`); process.exit(1) }
console.log(`\n${output}\n${path.join(opt.out, "driftmower-demo.srt")}  (${(tourEnd - tourStart).toFixed(0)}s, ${voiced.length} narrated shots)`)
