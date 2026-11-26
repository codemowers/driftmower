{{/*
Optional admin-provided CA bundle for outbound TLS. The images contain no CA
certificates and expect the cluster to supply them, as the codemowers
platform's workload-trusted-ca admission policy does. These paths match that
policy, which leaves existing mounts and SSL_CERT_FILE untouched.
*/}}
{{- define "driftmower.trustedCA.env" -}}
{{- if .Values.trustedCA.configMapName }}
- name: SSL_CERT_FILE
  value: /etc/ssl/certs/ca.pem
{{- end }}
{{- end }}

{{- define "driftmower.trustedCA.volumeMount" -}}
{{- if .Values.trustedCA.configMapName }}
- name: trusted-ca
  mountPath: /etc/ssl/certs/ca.pem
  subPath: ca.pem
  readOnly: true
{{- end }}
{{- end }}

{{- define "driftmower.trustedCA.volume" -}}
{{- with .Values.trustedCA.configMapName }}
- name: trusted-ca
  configMap:
    name: {{ . | quote }}
    items:
      - key: {{ $.Values.trustedCA.key | quote }}
        path: ca.pem
{{- end }}
{{- end }}
