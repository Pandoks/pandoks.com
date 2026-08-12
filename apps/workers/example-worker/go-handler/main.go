package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/signal"
	runtimev1 "queueworker/runtime/v1"
	"syscall"
	"time"

	"google.golang.org/grpc"
)

type handler struct {
	runtimev1.UnimplementedHandlerServer
}

func (handler) Handle(
	_ context.Context,
	request *runtimev1.HandleRequest,
) (*runtimev1.HandleResponse, error) {
	return &runtimev1.HandleResponse{
		Outcome: runtimev1.Outcome_OUTCOME_SUCCESS,
		Publications: []*runtimev1.Publication{{
			Id:   request.GetId() + ":example",
			Body: request.GetBody(),
		}},
	}, nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run() error {
	port := os.Getenv("HANDLER_GRPC_PORT")
	if port == "" {
		port = "9000"
	}
	listener, err := net.Listen("tcp", "0.0.0.0:"+port)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	server := grpc.NewServer()
	runtimev1.RegisterHandlerServer(server, handler{})
	ctx, stop := signal.NotifyContext(
		context.Background(),
		syscall.SIGINT,
		syscall.SIGTERM,
	)
	defer stop()
	shutdownDone := make(chan struct{})
	go func() {
		<-ctx.Done()
		defer close(shutdownDone)
		drained := make(chan struct{})
		go func() {
			server.GracefulStop()
			close(drained)
		}()
		select {
		case <-drained:
		case <-time.After(30 * time.Second):
			server.Stop()
		}
	}()
	err = server.Serve(listener)
	if ctx.Err() != nil {
		<-shutdownDone
		return nil
	}
	return err
}
