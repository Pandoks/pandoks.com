package utils

import (
	"context"
	"fmt"
	"net"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

func GetClusterServiceFQDN(name, namespace string) string {
	return fmt.Sprintf("valkey-%s-cluster.%s.svc.cluster.local", name, namespace)
}

func GetPodHeadlessServiceFQDN(name, namespace string, index int) string {
	return fmt.Sprintf("%s.%s", GetStatefulsetPodName(name, index), GetHeadlessServiceFQDN(name, namespace))
}

func GetHeadlessServiceFQDN(name, namespace string) string {
	return fmt.Sprintf("valkey-%s-headless.%s.svc.cluster.local", name, namespace)
}

func GetStatefulsetName(name string) string {
	return fmt.Sprintf("valkey-%s", name)
}

func GetStatefulsetPodName(name string, index int) string {
	return fmt.Sprintf("valkey-%s-%d", name, index)
}

// hostnames & ips include port
func GetAllServicePods(serviceFQDN string) (ips []string, hostnames []string, err error) {
	ips, err = net.LookupHost(serviceFQDN)
	if err != nil {
		return nil, nil, err
	}

	_, addrs, err := net.LookupSRV("", "", serviceFQDN)
	if err != nil {
		return nil, nil, err
	}

	hostnames = make([]string, 0, len(addrs))
	for _, addr := range addrs {
		hostnames = append(hostnames, fmt.Sprintf("%s:%d", addr.Target, int(addr.Port)))
	}

	return ips, hostnames, nil
}

func WaitForStatefulSetReady(ctx context.Context, namespace, name string, expectedReplicas int) error {
	fmt.Println("Waiting for StatefulSet to be fully ready...")

	config, err := rest.InClusterConfig()
	if err != nil {
		return fmt.Errorf("failed to get in-cluster config: %w", err)
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return fmt.Errorf("failed to create kubernetes client: %w", err)
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		sts, err := clientset.AppsV1().StatefulSets(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return fmt.Errorf("failed to get statefulset: %w", err)
		}

		ready := sts.Status.ReadyReplicas == int32(expectedReplicas)
		updated := sts.Status.UpdatedReplicas == int32(expectedReplicas)
		rolloutComplete := sts.Status.CurrentRevision == sts.Status.UpdateRevision

		if ready && updated && rolloutComplete {
			fmt.Println("✓ StatefulSet is fully ready and updated")
			return nil
		}

		fmt.Printf("Waiting for StatefulSet... (ready: %d/%d, updated: %d/%d, rollout complete: %v)\n",
			sts.Status.ReadyReplicas, expectedReplicas,
			sts.Status.UpdatedReplicas, expectedReplicas,
			rolloutComplete)

		time.Sleep(2 * time.Second)
	}
}
