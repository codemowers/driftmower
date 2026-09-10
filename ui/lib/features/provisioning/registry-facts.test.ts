import assert from "node:assert/strict"
import { test } from "node:test"

import {
  isUpstream,
  pushAdvice,
  registriesInPullSecret,
  registryHostOf,
  summariseRegistries,
} from "./registry-facts.ts"

test("a registry host is told apart from a Docker Hub namespace", () => {
  assert.equal(registryHostOf("zot.ee-lte-1.codemowers.io/originaldreamer/driftmower-ui"), "zot.ee-lte-1.codemowers.io")
  assert.equal(registryHostOf("quay.io/jetstack/cert-manager-controller"), "quay.io")
  assert.equal(registryHostOf("localhost/driftmower-ui"), "localhost")
  assert.equal(registryHostOf("registry:5000/app"), "registry:5000")
  // "codemowers" is a Docker Hub org, not a hostname — the dot test is what
  // separates the two, and getting it wrong invents a registry.
  assert.equal(registryHostOf("codemowers/mikrotik-exporter"), "docker.io")
  assert.equal(registryHostOf("nginx"), "docker.io")
})

test("a digest does not leak into the host", () => {
  assert.equal(registryHostOf("zot.ee-lte-1.codemowers.io/app@sha256:abc"), "zot.ee-lte-1.codemowers.io")
})

test("public upstreams are never a push target", () => {
  assert.equal(isUpstream("docker.io"), true)
  assert.equal(isUpstream("registry.k8s.io"), true)
  assert.equal(isUpstream("ghcr.io"), true)
  assert.equal(isUpstream("zot.ee-lte-1.codemowers.io"), false)
})

test("the house registry is the busiest non-upstream one, not the busiest overall", () => {
  // A real cluster pulls far more images from upstreams than from its own zot.
  const images = [
    "registry.k8s.io/kube-proxy:v1.30.0",
    "registry.k8s.io/coredns:v1.11.1",
    "registry.k8s.io/etcd:3.5.12",
    "quay.io/jetstack/cert-manager-controller:v1.20.0",
    "docker.io/library/nginx:1.27",
    "zot.ee-lte-1.codemowers.io/originaldreamer/driftmower-ui:0.1.0",
    "zot.ee-lte-1.codemowers.io/originaldreamer/driftmower-be:0.1.0",
  ]
  const facts = summariseRegistries(images, new Set())

  assert.equal(facts[0].host, "zot.ee-lte-1.codemowers.io")
  assert.equal(facts[0].isHouseRegistry, true)
  assert.equal(facts[0].imageCount, 2)
  // registry.k8s.io has more images but must never be offered as a push target.
  assert.equal(facts.find(f => f.host === "registry.k8s.io")?.isHouseRegistry, false)
})

test("a cluster running only upstream images has no house registry", () => {
  const facts = summariseRegistries(["registry.k8s.io/pause:3.9", "docker.io/library/redis:7"], new Set())
  assert.equal(facts.some(f => f.isHouseRegistry), false)
  assert.match(pushAdvice(facts, []).advice, /no in-cluster registry/)
})

test("pull-secret registries are read from the auths keys only", () => {
  const json = JSON.stringify({
    auths: {
      "zot.ee-lte-1.codemowers.io": { username: "u", password: "p", auth: "dTpw" },
      "https://index.docker.io/v1/": { auth: "dTpw" },
    },
  })
  assert.deepEqual(registriesInPullSecret(json), ["zot.ee-lte-1.codemowers.io", "index.docker.io"])
})

test("a malformed pull secret yields nothing rather than throwing", () => {
  assert.deepEqual(registriesInPullSecret("not json"), [])
  assert.deepEqual(registriesInPullSecret("{}"), [])
})

test("advice names the pull secret when the namespace already has one", () => {
  const facts = summariseRegistries(["zot.ee-lte-1.codemowers.io/app:1"], new Set(["zot.ee-lte-1.codemowers.io"]))
  const advice = pushAdvice(facts, [{ name: "registry-secret", registries: ["zot.ee-lte-1.codemowers.io"] }])

  assert.equal(advice.registry, "zot.ee-lte-1.codemowers.io")
  assert.match(advice.advice, /registry-secret/)
  assert.match(advice.advice, /already exists/)
})

test("without a pull secret the advice predicts the real symptom, and rules out the wrong fix", () => {
  const facts = summariseRegistries(["zot.ee-lte-1.codemowers.io/app:1"], new Set())
  const advice = pushAdvice(facts, [])

  assert.match(advice.advice, /ImagePullBackOff/)
  // Image pulls happen on the node, so a network policy is not the remedy —
  // and a sandbox user could not create one anyway.
  assert.match(advice.advice, /done by the node/)
  assert.match(advice.advice, /not what fixes this/)
})

test("a pull secret for a different registry does not count as covering", () => {
  const facts = summariseRegistries(["zot.ee-lte-1.codemowers.io/app:1"], new Set())
  const advice = pushAdvice(facts, [{ name: "ghcr-secret", registries: ["ghcr.io"] }])
  assert.match(advice.advice, /no imagePullSecret for it/)
})

test("empty and blank images are ignored rather than counted", () => {
  assert.deepEqual(summariseRegistries(["", "zot.example.com/a:1"], new Set()).map(f => f.host), ["zot.example.com"])
})

test("a single-segment image's colon is a tag, not a registry port", () => {
  // Seen live: "redis:7-alpine" was reported as a registry host, inventing a
  // registry nobody could push to.
  assert.equal(registryHostOf("redis:7-alpine"), "docker.io")
  assert.equal(registryHostOf("nginx:1.27"), "docker.io")
  assert.equal(registryHostOf("redis"), "docker.io")
  // A port is only a port when a path follows it.
  assert.equal(registryHostOf("registry:5000/app:1"), "registry:5000")
})
