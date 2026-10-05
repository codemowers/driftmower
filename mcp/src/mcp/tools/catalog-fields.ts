// Defaults still inform internal provisioning decisions, but the response
// catalogs omit the redundant flag.
export function omitDefaultFlag<T extends object>(item: T): Omit<T, 'isDefault'> {
  const result = { ...item }

  delete (result as { isDefault?: unknown }).isDefault

  return result
}
