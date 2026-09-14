import { managerScope, type ActionFacts } from "../actions/types.ts"

export function fixKey(facts: ActionFacts): string {
  return `${facts.kind}:${facts.repository}|${facts.from}|${facts.to}|${managerScope(facts.manager)}`
}
