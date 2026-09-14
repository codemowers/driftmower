import type { CapabilitiesResult, DriftmowerUiClient } from '../clients/driftmower-ui.js'
import type {
  CapabilityResponse,
  DegradedRead,
  HostRule,
  NamespaceFact,
  OfferingCard,
  OfferingId,
  StorageClassFact
} from '../domain/provisioning.js'

// Read-only views over driftmower-ui's provisioning capability layer.
//
// Every result is either `ok` or a named unavailability. The `degraded` list
// travels with the ok results untouched: a fact that could not be read must
// never arrive looking like a fact that was read and came back empty.

export type UnavailableReason = 'unauthorized' | 'unreachable' | 'bad_response' | 'not_in_cluster'

export interface Unavailable {
  status: 'unavailable'
  reason: UnavailableReason
  detail: string
}

export interface ClusterCapabilities {
  status: 'ok'
  storageClasses: StorageClassFact[]
  topology: CapabilityResponse['topology']
  priorityClasses: CapabilityResponse['priorityClasses']
  networkPolicyEngine: CapabilityResponse['networkPolicyEngine']
  monitoringOperator: boolean
  ingress: CapabilityResponse['ingress']
  policies: CapabilityResponse['policies']
  admissionPolicies: CapabilityResponse['admissionPolicies']
  offeringsReady: number
  offeringsTotal: number
  degraded: DegradedRead[]
}

export interface OfferingsListing {
  status: 'ok'
  offerings: OfferingCard[]
  degraded: DegradedRead[]
}

export interface NamespaceReadiness {
  status: 'ok'
  requested: string[]
  namespaces: NamespaceFact[]
  hostRules: HostRule[]
  // Namespaces the caller asked about that came back with no facts. Almost
  // always tenancy: driftmower-ui drops namespaces outside the caller's scope
  // rather than erroring, so silence here means "not yours", not "not there".
  withheld: string[]
  degraded: DegradedRead[]
}

export interface StorageClassExplanation {
  status: 'ok'
  storageClass: StorageClassFact
  answers: {
    nodeLocal: boolean
    pinnedToOneNode: boolean
    growable: boolean
    survivesDeletion: boolean
    safeForReplicas: boolean
  }
  degraded: DegradedRead[]
}

export interface StorageClassNotFound {
  status: 'not_found'
  requested: string
  available: string[]
}

export class ProvisioningService {
  constructor(private readonly client: DriftmowerUiClient) {}

  async describeClusterCapabilities(accessToken: string | null): Promise<ClusterCapabilities | Unavailable> {
    const result = await this.load(accessToken)

    if (result.status !== 'ok') {
      return result
    }

    const { capabilities } = result

    return {
      status: 'ok',
      storageClasses: capabilities.storageClasses,
      topology: capabilities.topology,
      priorityClasses: capabilities.priorityClasses,
      networkPolicyEngine: capabilities.networkPolicyEngine,
      monitoringOperator: capabilities.monitoringOperator,
      ingress: capabilities.ingress,
      policies: capabilities.policies,
      admissionPolicies: capabilities.admissionPolicies,
      offeringsReady: capabilities.offerings.filter(offering => offering.availability.state === 'ready')
        .length,
      offeringsTotal: capabilities.offerings.length,
      degraded: capabilities.degraded
    }
  }

  async listOfferings(
    accessToken: string | null,
    offering?: OfferingId
  ): Promise<OfferingsListing | Unavailable> {
    const result = await this.load(accessToken, { offering })

    if (result.status !== 'ok') {
      return result
    }

    return {
      status: 'ok',
      offerings: offering
        ? result.capabilities.offerings.filter(card => card.id === offering)
        : result.capabilities.offerings,
      degraded: result.capabilities.degraded
    }
  }

  async describeNamespaceReadiness(
    accessToken: string | null,
    namespaces: string[]
  ): Promise<NamespaceReadiness | Unavailable> {
    const requested = [...new Set(namespaces.map(namespace => namespace.trim()).filter(Boolean))]
    const result = await this.load(accessToken, { namespaces: requested })

    if (result.status !== 'ok') {
      return result
    }

    const returned = new Set(result.capabilities.namespaces.map(fact => fact.namespace))

    return {
      status: 'ok',
      requested,
      namespaces: result.capabilities.namespaces,
      hostRules: result.capabilities.ingress.hostRules,
      withheld: requested.filter(namespace => !returned.has(namespace)),
      degraded: result.capabilities.degraded
    }
  }

  async explainStorageClass(
    accessToken: string | null,
    name: string
  ): Promise<StorageClassExplanation | StorageClassNotFound | Unavailable> {
    const result = await this.load(accessToken)

    if (result.status !== 'ok') {
      return result
    }

    const storageClass = result.capabilities.storageClasses.find(candidate => candidate.name === name)

    if (!storageClass) {
      return {
        status: 'not_found',
        requested: name,
        available: result.capabilities.storageClasses.map(candidate => candidate.name)
      }
    }

    return {
      status: 'ok',
      storageClass,
      answers: explainStorageClassFact(storageClass),
      degraded: result.capabilities.degraded
    }
  }

  private async load(
    accessToken: string | null,
    query: { namespaces?: string[]; offering?: OfferingId } = {}
  ): Promise<{ status: 'ok'; capabilities: CapabilityResponse } | Unavailable> {
    const result: CapabilitiesResult = await this.client.fetchCapabilities(accessToken, query)

    if (!result.ok) {
      return { status: 'unavailable', reason: result.reason, detail: result.detail }
    }

    if (!result.capabilities.inCluster) {
      return {
        status: 'unavailable',
        reason: 'not_in_cluster',
        detail:
          'driftmower-ui is not running inside a Kubernetes cluster, so it can report no cluster facts. ' +
          'These tools only answer against an in-cluster deployment.'
      }
    }

    return { status: 'ok', capabilities: result.capabilities }
  }
}

// Pure, so the plain-language answers are testable without a cluster or an HTTP
// round trip.
export function explainStorageClassFact(storageClass: StorageClassFact): StorageClassExplanation['answers'] {
  return {
    nodeLocal: storageClass.topology === 'node-local',
    // Immediate binding on a node-local provisioner is the trap: the volume is
    // placed before the pod is scheduled, so the pod inherits that node.
    pinnedToOneNode: storageClass.topology === 'node-local',
    growable: storageClass.allowExpansion,
    // Retain keeps the underlying volume after the PVC goes away; Delete does
    // not. This is the difference between a deleted database being recoverable
    // and being gone.
    survivesDeletion: storageClass.reclaimPolicy === 'Retain',
    safeForReplicas: storageClass.replicaSafe
  }
}
