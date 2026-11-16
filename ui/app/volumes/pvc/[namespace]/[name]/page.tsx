"use client"
import { useParams } from "next/navigation"
import VolumeDetail from "@/app/volumes/components/volume-detail"
export default function ClaimPage() { const params = useParams<{ namespace: string; name: string }>(); return <VolumeDetail namespace={decodeURIComponent(params.namespace)} claim={decodeURIComponent(params.name)} /> }
