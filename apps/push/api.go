package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
)

func (service *service) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(http.ResponseWriter, *http.Request) {})
	mux.HandleFunc("GET /readyz", func(writer http.ResponseWriter, request *http.Request) {
		if err := service.database.Ping(request.Context()); err != nil {
			http.Error(writer, err.Error(), http.StatusServiceUnavailable)
		}
	})
	mux.HandleFunc("PUT /devices/{token}", service.registerDevice)
	mux.HandleFunc("DELETE /devices/{token}", service.unregisterDevice)
	mux.HandleFunc("POST /notifications", service.sendNotification)
	mux.HandleFunc("DELETE /notifications/{id}", service.cancelNotification)
	return http.TimeoutHandler(mux, databaseTimeout, "")
}

func (service *service) registerDevice(writer http.ResponseWriter, request *http.Request) {
	var device struct {
		Platform        string `json:"platform"`
		Kind            string `json:"kind"`
		App             string `json:"app"`
		UserID          string `json:"user_id"`
		APNsEnvironment string `json:"apns_environment"`
	}
	if err := json.NewDecoder(request.Body).Decode(&device); err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)
		return
	}
	validPlatform := (device.Platform == "ios" && slices.Contains([]string{"sandbox", "production"}, device.APNsEnvironment)) ||
		(device.Platform == "android" && device.APNsEnvironment == "")
	if !validPlatform || !slices.Contains([]string{"device", "liveactivity"}, device.Kind) || device.App == "" || device.UserID == "" {
		http.Error(writer, "platform must be ios with apns_environment sandbox or production, or android without it; kind must be device or liveactivity; app and user_id are required", http.StatusBadRequest)
		return
	}

	_, err := service.database.Exec(request.Context(), `
		INSERT INTO push_devices (token, platform, kind, app, user_id, apns_environment) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (token) DO UPDATE SET
		  platform = excluded.platform, kind = excluded.kind, app = excluded.app, user_id = excluded.user_id,
		  apns_environment = excluded.apns_environment, updated_at = now()`,
		request.PathValue("token"), device.Platform, device.Kind, device.App, device.UserID, device.APNsEnvironment,
	)
	if err != nil {
		internalError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (service *service) unregisterDevice(writer http.ResponseWriter, request *http.Request) {
	if _, err := service.database.Exec(request.Context(), `DELETE FROM push_devices WHERE token = $1`, request.PathValue("token")); err != nil {
		internalError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (service *service) sendNotification(writer http.ResponseWriter, request *http.Request) {
	var notification notification
	if err := json.NewDecoder(request.Body).Decode(&notification); err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)
		return
	}
	// NOTE: attempt counts a queued job's retries and isn't the caller's to set
	notification.Attempt = 0
	isObject := func(payload json.RawMessage) bool {
		var object map[string]json.RawMessage
		return payload == nil || (json.Unmarshal(payload, &object) == nil && object != nil)
	}
	// NOTE: user_ids and tokens become separate jobs, so a token of one of the users would get it twice
	if notification.App == "" || !slices.Contains([]string{"alert", "background", "liveactivity"}, notification.PushType) ||
		(len(notification.UserIDs) == 0) == (len(notification.Tokens) == 0) || (notification.APNs == nil && notification.FCM == nil) ||
		!isObject(notification.APNs) || !isObject(notification.FCM) {
		http.Error(writer, "app, push_type (alert, background, or liveactivity), either user_ids or tokens, and an apns or fcm object are required", http.StatusBadRequest)
		return
	}

	id, err := service.enqueue(request.Context(), notification)
	if err != nil {
		internalError(writer, err)
		return
	}
	writer.Header().Set("content-type", "application/json")
	writer.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(writer).Encode(map[string]string{"id": strconv.FormatInt(id, 10)})
}

func (service *service) cancelNotification(writer http.ResponseWriter, request *http.Request) {
	id, err := strconv.ParseInt(request.PathValue("id"), 10, 64)
	if err != nil {
		http.NotFound(writer, request)
		return
	}
	deleted, err := service.database.Exec(request.Context(), `
		DELETE FROM push_jobs WHERE id IN (SELECT id FROM push_jobs WHERE notification_id = $1 FOR UPDATE SKIP LOCKED)`, id)
	if err != nil {
		internalError(writer, err)
		return
	}
	if deleted.RowsAffected() == 0 {
		http.NotFound(writer, request)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func internalError(writer http.ResponseWriter, err error) {
	slog.Error("request failed", "error", err)
	http.Error(writer, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
}
