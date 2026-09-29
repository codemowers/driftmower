import { expect, it } from 'vitest'

import {
  detectControlPlaneLabel,
  distinctZones,
  isSchedulable,
  toTopologyFact,
  type RawNode
} from './topology-facts.js'

const ready = { conditions: [{ type: 'Ready', status: 'True' }], allocatable: { cpu: '4', memory: '8Gi' } }

it('cordoned, not-ready and NoSchedule-tainted nodes cannot host a new instance', () => {
  expect(isSchedulable({ status: ready })).toBe(true)
  expect(isSchedulable({ spec: { unschedulable: true }, status: ready })).toBe(false)
  expect(isSchedulable({ status: { conditions: [{ type: 'Ready', status: 'False' }] } })).toBe(false)
  expect(isSchedulable({ spec: { taints: [{ key: 'x', effect: 'NoSchedule' }] }, status: ready })).toBe(false)
  // PreferNoSchedule is a hint, not a barrier.
  expect(isSchedulable({ spec: { taints: [{ key: 'x', effect: 'PreferNoSchedule' }] }, status: ready })).toBe(
    true
  )
})

it('capacity is summed per zone, and only over schedulable nodes', () => {
  const nodes: RawNode[] = [
    { metadata: { labels: { 'topology.kubernetes.io/zone': 'eu-a' } }, status: ready },
    { metadata: { labels: { 'topology.kubernetes.io/zone': 'eu-a' } }, status: ready },
    { metadata: { labels: { 'topology.kubernetes.io/zone': 'eu-b' } }, status: ready },
    // Cordoned: must not inflate either the node count or the capacity.
    {
      metadata: { labels: { 'topology.kubernetes.io/zone': 'eu-b' } },
      spec: { unschedulable: true },
      status: ready
    }
  ]
  const topology = toTopologyFact(nodes)

  expect(topology.schedulableNodes).toBe(3)
  expect(topology.zones.map(z => [z.zone, z.nodes])).toEqual([
    ['eu-a', 2],
    ['eu-b', 1]
  ])
  expect(topology.zones[0].allocatable.cpuMillis).toBe(8000)
  expect(topology.zones[0].allocatable.memoryBytes).toBe(2 * 8 * 1024 ** 3)
})

it('an unzoned cluster reports zero usable zones, so spreading is decoration', () => {
  const topology = toTopologyFact([{ status: ready }, { status: ready }])

  expect(topology.schedulableNodes).toBe(2)
  expect(distinctZones(topology)).toBe(0)
  expect(topology.zones[0].zone).toBe('(no zone label)')
})

it('the control-plane label is derived, not configured', () => {
  // k3s / ee-lte-1
  expect(
    detectControlPlaneLabel([{ metadata: { labels: { 'node-role.kubernetes.io/control-plane': 'true' } } }])
  ).toEqual({ key: 'node-role.kubernetes.io/control-plane', value: 'true' })
  // the AWS clusters
  expect(
    detectControlPlaneLabel([{ metadata: { labels: { 'codemowers.cloud/node-role': 'control-plane' } } }])
  ).toEqual({ key: 'codemowers.cloud/node-role', value: 'control-plane' })
  expect(detectControlPlaneLabel([{ metadata: { labels: { foo: 'bar' } } }])).toBe(null)
})

it('a node carrying both labels reports the more specific one', () => {
  const label = detectControlPlaneLabel([
    {
      metadata: {
        labels: {
          'node-role.kubernetes.io/control-plane': 'true',
          'codemowers.cloud/node-role': 'control-plane'
        }
      }
    }
  ])

  expect(label?.key).toBe('codemowers.cloud/node-role')
})
