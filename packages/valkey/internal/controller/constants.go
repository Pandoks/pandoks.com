package controller

const (
	valkeyPort                int32  = 6379
	defaultClusterNodeTimeout string = "15000"
	valkeyConfigFileName      string = "valkey.conf"
	valkeyConfigVolumeName    string = "valkey-config"
	dataVolumeName            string = "data"
	defaultValkeyImage        string = "ghcr.io/pandoks/valkey:latest"

	clusterLabelKey       string = "valkey.pandoks.com/cluster"
	masterOrdinalLabelKey string = "valkey.pandoks.com/master-ordinal"
)
