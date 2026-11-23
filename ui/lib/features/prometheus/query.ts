export type ResourceTriplet = {
  usage: number | null
  limit: number | null
  request: number | null
}

export type PodVolume = {
  name: string
  used: number
  capacity: number
}
