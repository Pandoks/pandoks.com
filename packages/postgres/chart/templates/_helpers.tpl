{{/* Nested PgDog Helm release; previews override it so releases stay unique. */}}
{{- define "postgres.pgdogRelease" -}}
{{- .Values.pgdog.releaseName | default (printf "%s-pgdog" .Values.db) -}}
{{- end -}}

{{/* PgDog Service name, mirroring the pgdog chart's fullname rule. */}}
{{- define "postgres.pgdogService" -}}
{{- $release := include "postgres.pgdogRelease" . -}}
{{- if .Values.pgdog.fullnameOverride -}}
{{- .Values.pgdog.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if contains "pgdog" $release -}}
{{- $release | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-pgdog" $release | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
