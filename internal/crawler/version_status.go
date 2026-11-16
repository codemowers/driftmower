package crawler

// VersionStatus is the shared presentation for MCP consumers and the direct
// browser summary. Incomplete crawls must never appear up to date.
func VersionStatus(source *SourceReport, version *DeployedVersion) map[string]any {
	out := map[string]any{"statusType": "no_version", "deployedTag": version.Version, "latestTag": nil, "majorDifference": 0, "minorDifference": 0, "patchDifference": 0}
	if source.Latest != nil {
		out["latestTag"] = source.Latest.Tag
	}
	status := "no_version"
	if version.Behind >= 0 {
		status = "up_to_date"
		if version.Behind > 0 {
			status = "behind"
		}
	}
	deployed, dok := ParseVersion(version.Version)
	if source.Latest != nil {
		latest, lok := ParseVersion(source.Latest.Tag)
		if dok && lok && version.Behind > 0 && deployed.Prefix == latest.Prefix {
			out["majorDifference"] = max(0, latest.component(0)-deployed.component(0))
			out["minorDifference"] = max(0, latest.component(1)-deployed.component(1))
			out["patchDifference"] = max(0, latest.component(2)-deployed.component(2))
			switch {
			case latest.component(0) > deployed.component(0):
				status = "major_behind"
			case latest.component(1) > deployed.component(1):
				status = "minor_behind"
			default:
				status = "patch_behind"
			}
		}
	}
	if source.CheckedAt.IsZero() || len(source.Errors) > 0 {
		status = "no_data"
	}
	out["statusType"] = status
	return out
}
