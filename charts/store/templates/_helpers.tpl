{{/* Resource name prefix: the release name (one store per release). */}}
{{- define "store.fullname" -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{- define "store.labels" -}}
app.kubernetes.io/part-of: urumi-store
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "store.selectorLabels" -}}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/name: {{ .component }}
{{- end -}}

{{- define "store.url" -}}
{{- if .Values.store.url -}}
{{- .Values.store.url -}}
{{- else -}}
{{- ternary "https" "http" .Values.ingress.tls.enabled }}://{{ .Values.ingress.host }}
{{- end -}}
{{- end -}}

{{- define "store.image" -}}
{{- with .Values.image -}}
{{- if .registry }}{{ .registry }}/{{ end }}{{ .repository }}:{{ .tag }}
{{- end -}}
{{- end -}}

{{/* Secret names: the existing Secret if configured, otherwise the generated one. */}}
{{- define "store.dbSecret" -}}
{{- .Values.secrets.database.existingSecret | default (printf "%s-db" (include "store.fullname" .)) -}}
{{- end -}}
{{- define "store.wpSecret" -}}
{{- .Values.secrets.wordpress.existingSecret | default (printf "%s-wordpress" (include "store.fullname" .)) -}}
{{- end -}}
{{- define "store.wcApiSecret" -}}
{{- .Values.secrets.wcApi.existingSecret | default (printf "%s-wc-api" (include "store.fullname" .)) -}}
{{- end -}}

{{/*
Stable random secret value (base64). Reuses the value already in the cluster
so `helm upgrade` never rotates passwords out from under the database.
Args: dict "ctx" . "secret" <name> "key" <key> "length" <n> "prefix" <str>
*/}}
{{- define "store.randomSecretValue" -}}
{{- $existing := lookup "v1" "Secret" .ctx.Release.Namespace .secret -}}
{{- if and $existing $existing.data (hasKey $existing.data .key) -}}
{{- index $existing.data .key -}}
{{- else -}}
{{- printf "%s%s" (.prefix | default "") (randAlphaNum (int .length)) | b64enc -}}
{{- end -}}
{{- end -}}

{{- define "store.mariadbHost" -}}
{{- include "store.fullname" . }}-mariadb
{{- end -}}

{{/*
Environment shared by the web pods and the setup Job. The official image's
wp-config-docker.php reads all of these, so wp-config.php is never stored.
*/}}
{{- define "store.wordpressEnv" -}}
- name: WORDPRESS_DB_HOST
  value: "{{ include "store.mariadbHost" . }}:3306"
- name: WORDPRESS_DB_NAME
  value: {{ .Values.mariadb.database | quote }}
- name: WORDPRESS_DB_USER
  value: {{ .Values.mariadb.user | quote }}
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef: { name: {{ include "store.dbSecret" . }}, key: password }
{{- range $env, $key := dict "WORDPRESS_AUTH_KEY" "auth-key" "WORDPRESS_SECURE_AUTH_KEY" "secure-auth-key" "WORDPRESS_LOGGED_IN_KEY" "logged-in-key" "WORDPRESS_NONCE_KEY" "nonce-key" "WORDPRESS_AUTH_SALT" "auth-salt" "WORDPRESS_SECURE_AUTH_SALT" "secure-auth-salt" "WORDPRESS_LOGGED_IN_SALT" "logged-in-salt" "WORDPRESS_NONCE_SALT" "nonce-salt" }}
- name: {{ $env }}
  valueFrom:
    secretKeyRef: { name: {{ include "store.wpSecret" $ }}, key: {{ $key }} }
{{- end }}
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    define('WP_HOME', '{{ include "store.url" . }}');
    define('WP_SITEURL', '{{ include "store.url" . }}');
    define('WP_ENVIRONMENT_TYPE', '{{ .Values.wordpress.environmentType }}');
    define('DISALLOW_FILE_EDIT', true);
    define('DISALLOW_FILE_MODS', true);
    define('AUTOMATIC_UPDATER_DISABLED', true);
{{- end -}}

{{/* NetworkPolicy egress rule: DNS lookups via the cluster DNS pods. */}}
{{- define "store.dnsEgress" -}}
- to:
    - namespaceSelector:
        matchLabels: { kubernetes.io/metadata.name: {{ .Values.networkPolicy.dns.namespace }} }
      podSelector:
        matchLabels: {{- toYaml .Values.networkPolicy.dns.podLabels | nindent 10 }}
  ports:
    - { port: 53, protocol: UDP }
    - { port: 53, protocol: TCP }
{{- end -}}
