package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const schema = `
CREATE TABLE IF NOT EXISTS push_devices (
  token text PRIMARY KEY,
  platform text NOT NULL,
  kind text NOT NULL,
  app text NOT NULL,
  user_id text NOT NULL,
  apns_environment text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_devices_app_kind_user_id ON push_devices (app, kind, user_id);

CREATE SEQUENCE IF NOT EXISTS push_notification_ids;
CREATE TABLE IF NOT EXISTS push_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_id bigint NOT NULL,
  send_at timestamptz NOT NULL,
  job jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS push_jobs_send_at ON push_jobs (send_at);
CREATE INDEX IF NOT EXISTS push_jobs_notification_id ON push_jobs (notification_id);
`

type service struct {
	database *pgxpool.Pool
	apns     *apnsClient
	fcm      *fcmClient
	wake     chan struct{}
	sends    chan struct{}
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	var err error
	switch command := strings.Join(os.Args[1:], " "); command {
	case "":
		var listener net.Listener
		listener, err = net.Listen("tcp", ":8080") //nolint:gosec // the pod serves on its own IP
		if err == nil {
			err = run(ctx, listener)
		}
	case "migrate":
		err = migrate(ctx)
	default:
		err = fmt.Errorf("unknown command %q: run with no arguments to serve or with migrate", command)
	}
	if err != nil {
		slog.Error("push stopped", "error", err)
		os.Exit(1)
	}
}

// NOTE: pgx reads PGHOST, PGPORT, PGDATABASE, PGUSER, and PGPASSWORD
func migrate(ctx context.Context) error {
	connection, err := pgx.Connect(ctx, "")
	if err != nil {
		return err
	}
	defer func() { _ = connection.Close(ctx) }()
	_, err = connection.Exec(ctx, schema)
	return err
}

func run(ctx context.Context, listener net.Listener) error {
	databaseConfig, err := pgxpool.ParseConfig("")
	if err != nil {
		return err
	}
	// NOTE: every job worker holds a connection for its whole job
	databaseConfig.MaxConns = jobWorkers + apiConnections
	database, err := pgxpool.NewWithConfig(ctx, databaseConfig)
	if err != nil {
		return err
	}
	defer database.Close()

	// One pool of long-lived HTTP/2 connections shared by APNs and FCM
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.IdleConnTimeout = 0
	// NOTE: without a cap, a burst of sends before the first connection is up dials one per send
	transport.MaxConnsPerHost = 8
	transport.HTTP2 = &http.HTTP2Config{SendPingTimeout: time.Minute}

	apnsURLs := map[string]string{"production": os.Getenv("APNS_PRODUCTION_URL"), "sandbox": os.Getenv("APNS_SANDBOX_URL")}
	apns, err := newAPNsClient(transport, apnsURLs, os.Getenv("APNS_KEY_ID"), os.Getenv("APNS_TEAM_ID"), []byte(os.Getenv("APNS_KEY")))
	if err != nil {
		return err
	}
	fcm, err := newFCMClient(transport, os.Getenv("FCM_URL"), []byte(os.Getenv("FCM_SERVICE_ACCOUNT")))
	if err != nil {
		return err
	}

	service := &service{
		database: database,
		apns:     apns,
		fcm:      fcm,
		wake:     make(chan struct{}, jobWorkers),
		sends:    make(chan struct{}, sendConcurrency),
	}

	var workers sync.WaitGroup
	for range jobWorkers {
		workers.Go(func() { service.work(ctx) })
	}
	workers.Go(func() { service.listen(ctx) })

	server := &http.Server{Handler: service.routes(), ReadHeaderTimeout: 10 * time.Second}
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- server.Serve(listener) }()
	slog.Info("push started", "address", listener.Addr().String())

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
