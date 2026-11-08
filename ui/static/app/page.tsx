"use client"
import dynamic from "next/dynamic"
const Dashboard = dynamic(() => import("../../browser/dashboard"), { ssr: false })
export default function Page() { return <Dashboard/> }
