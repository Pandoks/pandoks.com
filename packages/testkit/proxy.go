package testkit

import (
	"context"
	"fmt"

	batchv1 "k8s.io/api/batch/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// PodProxyGet performs an HTTP GET against a pod port through the API server's
// pod proxy — no port-forward lifecycle to manage inside poll loops.
func (c *Cluster) PodProxyGet(ctx context.Context, namespace, pod string, port int, path string) ([]byte, error) {
	return c.Client.CoreV1().RESTClient().Get().
		Namespace(namespace).
		Resource("pods").
		Name(fmt.Sprintf("%s:%d", pod, port)).
		SubResource("proxy").
		Suffix(path).
		DoRaw(ctx)
}

// CreateJobFromCronJob materializes a CronJob's job template as a one-off Job,
// like `kubectl create job --from=cronjob/<name>`.
func (c *Cluster) CreateJobFromCronJob(ctx context.Context, namespace, cronJob, job string) error {
	cj, err := c.Client.BatchV1().CronJobs(namespace).Get(ctx, cronJob, metav1.GetOptions{})
	if err != nil {
		return err
	}
	_, err = c.Client.BatchV1().Jobs(namespace).Create(ctx, &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{Name: job, Namespace: namespace},
		Spec:       cj.Spec.JobTemplate.Spec,
	}, metav1.CreateOptions{})
	return err
}
