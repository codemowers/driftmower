import path from "node:path"
const root = path.resolve(import.meta.dirname, "..")
export default {
  output: "export", images: { unoptimized: true },
  webpack(config) {
    config.resolve.alias["next/navigation$"] = path.join(root,"browser/navigation.tsx")
    config.resolve.alias["next/link$"] = path.join(root,"browser/link.tsx")
    config.resolve.alias["@"] = root
    return config
  },
}
