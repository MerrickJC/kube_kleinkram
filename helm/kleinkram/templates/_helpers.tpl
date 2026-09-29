{{- define "kleinkram.name" -}}
kleinkram
{{- end -}}

{{- define "kleinkram.labels" -}}
app.kubernetes.io/name: {{ include "kleinkram.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "kleinkram.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kleinkram.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "kleinkram.image" -}}
{{ .root.Values.image.registry }}/{{ .root.Values.image.repository }}:{{ .service }}-{{ .root.Values.image.tag | default .root.Chart.AppVersion }}
{{- end -}}

{{- define "kleinkram.imagePullSecrets" -}}
imagePullSecrets:
  {{- range . }}
  - name: {{ . }}
  {{- end }}
{{- end -}}

{{/*
Env vars sourced from the db/s3/jwt/oauth Secrets, shared by api-server and
queue-consumer. Secret names come from .Values.secretNames, key names come
from .Values.secretKeys, so either can be overridden independently.
*/}}
{{- define "kleinkram.secretEnv" -}}
- name: DB_USER
  valueFrom: { secretKeyRef: { name: {{ .Values.secretNames.db }}, key: {{ .Values.secretKeys.db.user }} } }
- name: DB_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ .Values.secretNames.db }}, key: {{ .Values.secretKeys.db.password }} } }
- name: S3_ACCESS_KEY
  valueFrom: { secretKeyRef: { name: {{ .Values.secretNames.s3 }}, key: {{ .Values.secretKeys.s3.accessKey }} } }
- name: S3_SECRET_KEY
  valueFrom: { secretKeyRef: { name: {{ .Values.secretNames.s3 }}, key: {{ .Values.secretKeys.s3.secretKey }} } }
- name: S3_USER
  valueFrom: { secretKeyRef: { name: {{ .Values.secretNames.s3 }}, key: {{ .Values.secretKeys.s3.user }} } }
- name: S3_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ .Values.secretNames.s3 }}, key: {{ .Values.secretKeys.s3.password }} } }
- name: JWT_SECRET
  valueFrom: { secretKeyRef: { name: {{ .Values.secretNames.jwt }}, key: {{ .Values.secretKeys.jwt.secret }} } }
- name: GOOGLE_CLIENT_ID
  valueFrom: { secretKeyRef: { name: {{ .Values.secretNames.googleOauth }}, key: {{ .Values.secretKeys.googleOauth.clientId }} } }
- name: GOOGLE_CLIENT_SECRET
  valueFrom: { secretKeyRef: { name: {{ .Values.secretNames.googleOauth }}, key: {{ .Values.secretKeys.googleOauth.clientSecret }} } }
- name: GITHUB_CLIENT_ID
  valueFrom: { secretKeyRef: { name: {{ .Values.secretNames.githubOauth }}, key: {{ .Values.secretKeys.githubOauth.clientId }} } }
- name: GITHUB_CLIENT_SECRET
  valueFrom: { secretKeyRef: { name: {{ .Values.secretNames.githubOauth }}, key: {{ .Values.secretKeys.githubOauth.clientSecret }} } }
{{- if .Values.secretNames.oidcOauth }}
- name: OIDC_CLIENT_ID
  valueFrom: { secretKeyRef: { name: {{ .Values.secretNames.oidcOauth }}, key: {{ .Values.secretKeys.oidcOauth.clientId }} } }
- name: OIDC_CLIENT_SECRET
  valueFrom: { secretKeyRef: { name: {{ .Values.secretNames.oidcOauth }}, key: {{ .Values.secretKeys.oidcOauth.clientSecret }} } }
{{- end -}}
{{- end -}}
