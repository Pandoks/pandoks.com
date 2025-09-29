package main

import (
	"flag"
	"fmt"
	"os"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"

	ctrlruntime "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/metrics/server"

	valkeyv1 "valkey/operator/api/v1"
	"valkey/operator/internal/controller"
)

var scheme = runtime.NewScheme()
var setupLog = ctrlruntime.Log.WithName("setup")

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(valkeyv1.AddToScheme(scheme))
}

func main() {
	var metricsAddress string
	var probeAddress string
	var enableLeaderElection bool

	flag.StringVar(&metricsAddress, "metrics-bind-address", ":8080", "The address the metric endpoint binds to.")
	flag.StringVar(&probeAddress, "health-probe-bind-address", ":8081", "The address the probe endpoint binds to.")
	flag.BoolVar(&enableLeaderElection, "leader-elect", false, "Enable leader election for controller manager.")

	zapOptions := zap.Options{Development: true}
	zapOptions.BindFlags(flag.CommandLine)
	flag.Parse()

	ctrlruntime.SetLogger(zap.New(zap.UseFlagOptions(&zapOptions)))

	manager, err := ctrlruntime.NewManager(ctrlruntime.GetConfigOrDie(), ctrlruntime.Options{
		Scheme:                 scheme,
		Metrics:                server.Options{BindAddress: metricsAddress},
		HealthProbeBindAddress: probeAddress,
		LeaderElection:         enableLeaderElection,
		LeaderElectionID:       "valkey-operator",
	})
	if err != nil {
		setupLog.Error(err, "unable to start manager")
		os.Exit(1)
	}

	if err = manager.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to set up health check")
		os.Exit(1)
	}
	if err = manager.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to set up ready check")
		os.Exit(1)
	}

	if err = (&controller.ValkeyClusterReconciler{Client: manager.GetClient(), Scheme: manager.GetScheme()}).SetupWithManager(manager); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "ValkeyCluster")
		os.Exit(1)
	}

	setupLog.Info("starting manager")
	if err := manager.Start(ctrlruntime.SetupSignalHandler()); err != nil {
		fmt.Fprintf(os.Stderr, "problem running manager: %v\n", err)
		os.Exit(1)
	}
}
