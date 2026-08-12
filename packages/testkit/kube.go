package testkit

import (
	"bytes"
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
)

// Exec runs a command in a pod container and returns trimmed stdout.
func (c *Cluster) Exec(ctx context.Context, namespace, pod, container string, command ...string) (string, error) {
	req := c.Client.CoreV1().RESTClient().Post().
		Resource("pods").Name(pod).Namespace(namespace).SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: container,
			Command:   command,
			Stdout:    true,
			Stderr:    true,
		}, scheme.ParameterCodec)
	executor, err := remotecommand.NewSPDYExecutor(c.Config, "POST", req.URL())
	if err != nil {
		return "", fmt.Errorf("exec in %s/%s: %w", namespace, pod, err)
	}
	var stdout, stderr bytes.Buffer
	if err := executor.StreamWithContext(ctx, remotecommand.StreamOptions{Stdout: &stdout, Stderr: &stderr}); err != nil {
		return "", fmt.Errorf("exec %q in %s/%s: %w: %s", strings.Join(command, " "), namespace, pod, err, stderr.String())
	}
	return strings.TrimSpace(stdout.String()), nil
}

// PodNames returns the sorted names of pods matching a label selector.
func (c *Cluster) PodNames(ctx context.Context, namespace, selector string) ([]string, error) {
	pods, err := c.Client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: selector})
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(pods.Items))
	for _, p := range pods.Items {
		names = append(names, p.Name)
	}
	sort.Strings(names)
	return names, nil
}

// Fingerprint captures "name uid restartCounts" per pod, sorted — identical
// output before/after an operation proves zero pod churn.
func (c *Cluster) Fingerprint(ctx context.Context, namespace, selector string) (string, error) {
	pods, err := c.Client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: selector})
	if err != nil {
		return "", err
	}
	lines := make([]string, 0, len(pods.Items))
	for _, p := range pods.Items {
		line := fmt.Sprintf("%s %s", p.Name, p.UID)
		for _, cs := range p.Status.ContainerStatuses {
			line += fmt.Sprintf(" %d", cs.RestartCount)
		}
		lines = append(lines, line)
	}
	sort.Strings(lines)
	return strings.Join(lines, "\n"), nil
}

// PodUIDs returns the UIDs of pods matching a label selector.
func (c *Cluster) PodUIDs(ctx context.Context, namespace, selector string) (map[string]bool, error) {
	pods, err := c.Client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: selector})
	if err != nil {
		return nil, err
	}
	uids := make(map[string]bool, len(pods.Items))
	for _, p := range pods.Items {
		uids[string(p.UID)] = true
	}
	return uids, nil
}

// StsReady reports whether a StatefulSet has exactly want replicas, all ready,
// with its status caught up to the latest spec generation.
func (c *Cluster) StsReady(ctx context.Context, namespace, name string, want int32) bool {
	sts, err := c.Client.AppsV1().StatefulSets(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return false
	}
	return sts.Status.ObservedGeneration >= sts.Generation &&
		sts.Status.Replicas == want &&
		sts.Status.ReadyReplicas == want
}

// StsPodTemplateAnnotation reads an annotation off a StatefulSet's pod template.
func (c *Cluster) StsPodTemplateAnnotation(ctx context.Context, namespace, name, key string) (string, error) {
	sts, err := c.Client.AppsV1().StatefulSets(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	return sts.Spec.Template.Annotations[key], nil
}

func (c *Cluster) PodIP(ctx context.Context, namespace, name string) (string, error) {
	pod, err := c.Client.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	return pod.Status.PodIP, nil
}

func (c *Cluster) DeletePod(ctx context.Context, namespace, name string) error {
	return c.Client.CoreV1().Pods(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func (c *Cluster) EnsureNamespace(ctx context.Context, name string) error {
	_, err := c.Client.CoreV1().Namespaces().Create(ctx,
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name}}, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		return nil
	}
	return err
}

// DeleteNamespaceAndWait deletes a namespace (if present) and blocks until it
// is fully gone, so a fresh install never races a terminating namespace.
func (c *Cluster) DeleteNamespaceAndWait(ctx context.Context, name string, timeout time.Duration) error {
	err := c.Client.CoreV1().Namespaces().Delete(ctx, name, metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return wait.PollUntilContextTimeout(ctx, 3*time.Second, timeout, true, func(ctx context.Context) (bool, error) {
		_, err := c.Client.CoreV1().Namespaces().Get(ctx, name, metav1.GetOptions{})
		return apierrors.IsNotFound(err), nil
	})
}

func (c *Cluster) CreateSecret(ctx context.Context, namespace, name string, data map[string]string) error {
	_, err := c.Client.CoreV1().Secrets(namespace).Create(ctx, &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		StringData: data,
	}, metav1.CreateOptions{})
	return err
}

// JobSucceeded reports whether a batch Job has at least one successful completion.
func (c *Cluster) JobSucceeded(ctx context.Context, namespace, name string) bool {
	job, err := c.Client.BatchV1().Jobs(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return false
	}
	return job.Status.Succeeded >= 1
}
