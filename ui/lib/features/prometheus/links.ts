// A Prometheus graph page with one panel per expression.
export function prometheusGraphLink(base: string, exprs: string[], range = "1d"): string {
  const params = new URLSearchParams()
  exprs.forEach((expr, i) => {
    params.set(`g${i}.expr`, expr)
    params.set(`g${i}.tab`, "0")
    params.set(`g${i}.range_input`, range)
  })
  return `${base.replace(/\/+$/, "")}/graph?${params.toString()}`
}
