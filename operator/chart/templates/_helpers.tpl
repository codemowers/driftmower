{{- /* Usernames of the ServiceAccounts allowed to read the crawler's reports. */}}
{{- define "driftmower.allowedCallers" -}}
{{- $users := list }}
{{- range .Values.crawler.allowedCallers }}
{{- $users = append $users (printf "system:serviceaccount:%s:%s" .namespace .name) }}
{{- end }}
{{- join "," $users }}
{{- end -}}
