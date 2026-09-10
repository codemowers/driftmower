// PURE. A non-binding answer to "will kubectl apply actually be allowed?".
//
// We cannot know this for certain: SelfSubjectAccessReview answers for the
// pod's ServiceAccount rather than the user, SubjectAccessReview would need a
// create verb we deliberately do not hold, and we are not the kubelogin client
// so we cannot ask as the user. So this reads the namespace's RoleBindings and
// resolves what they grant — and because wildcards and role aggregation make
// that approximate, the result is a hint that must never become a blocker.
//
// One thing that makes it tractable: the RBAC aggregation controller flattens
// aggregated rules into the role's own `.rules`, so reading `admin` is enough
// and we never need the individually labelled member roles. Verified on a real
// cluster: `admin.rules` there carries 29 rules and covers no CRD group at all,
// which is precisely why this check is worth showing a user.

export type RawPolicyRule = {
  apiGroups?: string[]
  resources?: string[]
  verbs?: string[]
}

export type RawRoleRef = { kind?: string; name?: string }

export type RawRoleBinding = {
  metadata?: { name?: string }
  roleRef?: RawRoleRef
  subjects?: { kind?: string; name?: string; apiGroup?: string }[]
}

export type ResolvedRole = { name: string; rules: RawPolicyRule[] }

export type Verdict = { mayCreate: "likely" | "likely-not" | "unknown"; reason: string }

export type Caller = {
  sub: string
  groups: string[]
  // The apiserver's username form. On these clusters there is no
  // --oidc-username-prefix, so the User subject is "<issuer>#<sub>"; the empty
  // prefix is also tried so a plain-sub binding still matches.
  usernamePrefixes: string[]
}

function matchesAny(values: string[] | undefined, wanted: string): boolean {
  return (values ?? []).some(v => v === "*" || v === wanted)
}

export function ruleCovers(rule: RawPolicyRule, group: string, resource: string, verb: string): boolean {
  return matchesAny(rule.apiGroups, group) && matchesAny(rule.resources, resource) && matchesAny(rule.verbs, verb)
}

export function rulesCover(rules: RawPolicyRule[], group: string, resource: string, verb: string): boolean {
  return rules.some(rule => ruleCovers(rule, group, resource, verb))
}

export function bindingAppliesTo(binding: RawRoleBinding, caller: Caller): boolean {
  const usernames = new Set(caller.usernamePrefixes.map(prefix => `${prefix}${caller.sub}`))

  return (binding.subjects ?? []).some(subject => {
    if (subject.kind === "Group") return caller.groups.includes(subject.name ?? "")
    if (subject.kind === "User") return usernames.has(subject.name ?? "")
    return false
  })
}

export function mayCreate(
  bindings: RawRoleBinding[],
  roles: ResolvedRole[],
  caller: Caller,
  target: { group: string; plural: string },
): Verdict {
  const byName = new Map(roles.map(r => [r.name, r]))
  const applicable = bindings.filter(binding => bindingAppliesTo(binding, caller))

  if (applicable.length === 0) {
    return {
      mayCreate: "unknown",
      reason:
        "No RoleBinding in this namespace names you or one of your groups, but you may still have " +
        "access through a binding we cannot see. Run the can-i command below to be sure.",
    }
  }

  const unresolved: string[] = []

  for (const binding of applicable) {
    const roleName = binding.roleRef?.name
    if (!roleName) continue
    const role = byName.get(roleName)
    if (!role) {
      unresolved.push(roleName)
      continue
    }
    if (rulesCover(role.rules, target.group, target.plural, "create")) {
      return {
        mayCreate: "likely",
        reason: `The ${binding.metadata?.name ?? "matching"} RoleBinding grants you the ${roleName} role, which covers creating ${target.plural}.`,
      }
    }
  }

  if (unresolved.length > 0) {
    return {
      mayCreate: "unknown",
      reason:
        `You are bound to the ${unresolved.join(", ")} role here, whose rules we are not allowed to read. ` +
        "Run the can-i command below to check.",
    }
  }

  const roleNames = applicable.map(b => b.roleRef?.name).filter(Boolean).join(", ")
  return {
    mayCreate: "likely-not",
    reason:
      `You are bound to the ${roleNames} role in this namespace, and it does not cover ${target.group} ` +
      `resources. The built-in admin role only reaches a custom resource when its operator ships a ` +
      `ClusterRole labelled aggregate-to-admin, and this one has not. kubectl apply would return 403 ` +
      `until someone binds a role for this CRD.`,
  }
}
