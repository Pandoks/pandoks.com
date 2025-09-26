package controller

const (
	valkeyPort             int32  = 6379
	valkeyConfigFileName   string = "valkey.conf"
	valkeyConfigVolumeName string = "valkey-config"
	dataVolumeName         string = "data"

	clusterLabelKey string = "valkey.pandoks.com/cluster"
)
