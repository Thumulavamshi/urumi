{{/* Resource name prefix: the release name. */}}
{{- define "platform.fullname" -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{- define "platform.labels" -}}
app.kubernetes.io/part-of: urumi-platform
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/* The gateway's pods get app.kubernetes.io/name=gateway: the store's
NetworkPolicy admits exactly that label (in this namespace) to the MCP server. */}}
{{- define "platform.selectorLabels" -}}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/name: {{ .component }}
{{- end -}}

{{- define "platform.publicUrl" -}}
{{- if .Values.publicUrl -}}
{{- .Values.publicUrl | trimSuffix "/" -}}
{{- else -}}
{{- ternary "https" "http" .Values.ingress.tls.enabled }}://{{ .Values.ingress.host }}
{{- end -}}
{{- end -}}

{{- define "platform.gatewaySecret" -}}
{{- .Values.secrets.gateway.existingSecret | default (printf "%s-gateway" (include "platform.fullname" .)) -}}
{{- end -}}
{{- define "platform.postgresSecret" -}}
{{- .Values.secrets.postgres.existingSecret | default (printf "%s-postgres" (include "platform.fullname" .)) -}}
{{- end -}}
{{- define "platform.upstreamsSecret" -}}
{{- printf "%s-upstreams" (include "platform.fullname" .) -}}
{{- end -}}

{{/* Env var holding an upstream's credential, e.g. woo -> UPSTREAM_CRED_WOO */}}
{{- define "platform.credEnv" -}}
UPSTREAM_CRED_{{ . | upper | replace "-" "_" }}
{{- end -}}

{{/* Stable random value (already base64 for Secret .data); reuses the in-cluster value. */}}
{{- define "platform.randomSecretValue" -}}
{{- $existing := lookup "v1" "Secret" .ctx.Release.Namespace .secret -}}
{{- if and $existing $existing.data (hasKey $existing.data .key) -}}
{{- index $existing.data .key -}}
{{- else if .raw -}}
{{- .raw | b64enc -}}
{{- else -}}
{{- randAlphaNum (int .length) | b64enc -}}
{{- end -}}
{{- end -}}
