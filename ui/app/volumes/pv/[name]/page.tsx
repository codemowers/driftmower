"use client"
import { useParams } from "next/navigation"
import VolumeDetail from "@/app/volumes/components/volume-detail"
export default function PVPage() { const params = useParams<{ name: string }>(); return <VolumeDetail volume={decodeURIComponent(params.name)} /> }
