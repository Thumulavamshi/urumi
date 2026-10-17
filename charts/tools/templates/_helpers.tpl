{{- define "tools.fullname" -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{- define "tools.labels" -}}
app.kubernetes.io/part-of: urumi-tools
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "tools.selectorLabels" -}}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/name: {{ .component }}
{{- end -}}

{{- define "tools.image" -}}
{{- with .Values.image -}}
{{- if .registry }}{{ .registry }}/{{ end }}{{ .repository }}:{{ .tag }}
{{- end -}}
{{- end -}}

{{/* Credential Secret of one server (args: dict "ctx" . "component" "fx"). */}}
{{- define "tools.secretName" -}}
{{- (index .ctx.Values .component).existingSecret | default (printf "%s-%s" (include "tools.fullname" .ctx) .component) -}}
{{- end -}}

{{/* Stable random value (base64): reuses the in-cluster value so upgrades don't rotate it. */}}
{{- define "tools.randomSecretValue" -}}
{{- $existing := lookup "v1" "Secret" .ctx.Release.Namespace .secret -}}
{{- if and $existing $existing.data (hasKey $existing.data .key) -}}
{{- index $existing.data .key -}}
{{- else -}}
{{- randAlphaNum (int .length) | b64enc -}}
{{- end -}}
{{- end -}}

{{/* Pod-level security shared by both servers. */}}
{{- define "tools.podSecurity" -}}
enableServiceLinks: false
automountServiceAccountToken: false   # never talks to the Kubernetes API
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
  seccompProfile: { type: RuntimeDefault }
{{- end -}}

{{- define "tools.containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: { drop: [ALL] }
{{- end -}}

{{- define "tools.probes" -}}
readinessProbe:
  httpGet: { path: /readyz, port: http }
  periodSeconds: 10
livenessProbe:
  httpGet: { path: /healthz, port: http }
  periodSeconds: 20
  failureThreshold: 3
{{- end -}}

{{/* ClusterIP Service for one server (args: dict "ctx" . "component" "fx"). */}}
{{- define "tools.service" -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "tools.fullname" .ctx }}-{{ .component }}
  labels: {{- include "tools.labels" .ctx | nindent 4 }}
spec:
  type: ClusterIP
  selector: {{- include "tools.selectorLabels" . | nindent 4 }}
  ports:
    - name: http
      port: 80
      targetPort: http
{{- end -}}

{{/* Generated credential Secret, unless existingSecret is set. */}}
{{- define "tools.secret" -}}
{{- if not (index .ctx.Values .component).existingSecret }}
{{- $name := include "tools.secretName" . }}
apiVersion: v1
kind: Secret
metadata:
  name: {{ $name }}
  labels: {{- include "tools.labels" .ctx | nindent 4 }}
type: Opaque
data:
  token: {{ include "tools.randomSecretValue" (dict "ctx" .ctx "secret" $name "key" "token" "length" 48) }}
---
{{- end }}
{{- end -}}
