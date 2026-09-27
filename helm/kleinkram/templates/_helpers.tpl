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
