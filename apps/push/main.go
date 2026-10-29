package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/valkey-io/valkey-go"
)

const schema = `
CREATE TABLE IF NOT EXISTS push_devices (
  token text PRIMARY KEY,
  platform text NOT NULL,
  kind text NOT NULL,
  app text NOT NULL,
  user_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_devices_app_kind_user_id ON push_devices (app, kind, user_id);

CREATE TABLE IF NOT EXISTS push_scheduled_notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  send_at timestamptz NOT NULL,
  notification jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS push_scheduled_notifications_send_at ON push_scheduled_notifications (send_at);
`

type service struct {
	database *pgxpool.Pool
	valkey   valkey.Client
	apns     *apnsClient
	fcm      *fcmClient
	consumer string
	sends    chan struct{}
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	listener, err := net.Listen("tcp", ":8080") //nolint:gosec // the pod serves on its own IP
	if err == nil {
		err = run(ctx, listener)
	}
	if err != nil {
		slog.Error("push stopped", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, listener net.Listener) error {
	// NOTE: pgx reads PGHOST, PGPORT, PGDATABASE, PGUSER, and PGPASSWORD
	database, err := pgxpool.New(ctx, "")
	if err != nil {
		return err
	}
	defer database.Close()
	if _, err := database.Exec(ctx, schema); err != nil {
		return fmt.Errorf("create schema: %w", err)
	}

	valkeyClient, err := valkey.NewClient(valkey.ClientOption{
		InitAddress:  []string{os.Getenv("VALKEY_ADDRESS")},
		Username:     os.Getenv("VALKEY_USERNAME"),
		Password:     os.Getenv("VALKEY_PASSWORD"),
		DisableCache: true,
	})
	if err != nil {
		return fmt.Errorf("connect to valkey: %w", err)
	}
	defer valkeyClient.Close()
	if err := createJobGroup(ctx, valkeyClient); err != nil {
		return fmt.Errorf("create job consumer group: %w", err)
	}

	// One pool of long-lived HTTP/2 connections shared by APNs and FCM; http:// URLs use h2c.
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Protocols = new(http.Protocols)
	transport.Protocols.SetHTTP2(true)
	transport.Protocols.SetUnencryptedHTTP2(true)
	transport.IdleConnTimeout = 0
	// NOTE: without a cap, a burst of sends before the first connection is up dials one per send
	transport.MaxConnsPerHost = 8
	transport.HTTP2 = &http.HTTP2Config{SendPingTimeout: time.Minute}

	apns, err := newAPNsClient(transport, os.Getenv("APNS_URL"), os.Getenv("APNS_KEY_ID"), os.Getenv("APNS_TEAM_ID"), []byte(os.Getenv("APNS_KEY")))
	if err != nil {
		return err
	}
	fcm, err := newFCMClient(transport, os.Getenv("FCM_URL"), []byte(os.Getenv("FCM_SERVICE_ACCOUNT")))
	if err != nil {
		return err
	}
	hostname, err := os.Hostname()
	if err != nil {
		return err
	}

	service := &service{
		database: database,
		valkey:   valkeyClient,
		apns:     apns,
		fcm:      fcm,
		consumer: hostname,
		sends:    make(chan struct{}, sendConcurrency),
	}

	var workers sync.WaitGroup
	for range jobWorkers {
		workers.Go(func() { service.consume(ctx) })
	}
	workers.Go(func() { service.schedule(ctx) })

	server := &http.Server{Handler: service.routes(), ReadHeaderTimeout: 10 * time.Second}
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- server.Serve(listener) }()
	slog.Info("push started", "address", listener.Addr().String(), "consumer", hostname)

	select {
	case err := <-serveErrors:
		return err
	case <-ctx.Done():
	}
	shutdownContext, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	err = server.Shutdown(shutdownContext)
	workers.Wait()
	return err
}
