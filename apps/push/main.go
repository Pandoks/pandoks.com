package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"queue"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const schema = `
SELECT pg_advisory_xact_lock(hashtext('push_migrate'));

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
`

type service struct {
	database *pgxpool.Pool
	senders  map[string]sender
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
	if err := queue.Migrate(ctx, connection); err != nil {
		return err
	}
	_, err = connection.Exec(ctx, schema)
	return err
}

func run(ctx context.Context, listener net.Listener) error {
	databaseConfig, err := pgxpool.ParseConfig("")
	if err != nil {
		return err
	}
	databaseConfig.MaxConns = databaseConnections
	// NOTE: the pool dials in the background without the caller's deadline
	databaseConfig.ConnConfig.ConnectTimeout = databaseTimeout
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
		senders:  map[string]sender{"ios": apns, "android": fcm},
		sends:    make(chan struct{}, sendConcurrency),
	}

	var workers sync.WaitGroup
	workers.Go(func() {
		worker := queue.Worker{Pool: database, Queue: pushQueue, Name: os.Getenv("HOSTNAME"), Concurrency: jobWorkers, Handle: service.deliver}
		for ctx.Err() == nil {
			err := worker.Run(ctx)
			if ctx.Err() == nil {
				slog.Error("run jobs", "error", err)
				time.Sleep(time.Second)
			}
		}
	})

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
