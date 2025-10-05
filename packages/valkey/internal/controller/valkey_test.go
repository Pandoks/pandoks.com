package controller

import (
	"reflect"
	"testing"
)

func TestParseClusterNodes(t *testing.T) {
	r := &ValkeyClusterReconciler{}

	tests := []struct {
		name              string
		clusterNodeOutput string
		fqdnMap           map[string]string
		want              *ClusterTopology // nil if error
	}{
		{
			name: "healthy cluster - 3 masters 3 replicas - redis style (slave)",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected 0-5460
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 10.1.0.3:6379@16379 master - 0 1538428699000 2 connected 5461-10922
292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f 10.1.0.4:6379@16379 master - 0 1538428697000 3 connected 10923-16383
e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca 10.1.0.5:6379@16379 slave 07c37dfeb235213a872192d05877c5d02d9a7e1f 0 1538428699000 4 connected
c8e7e5c5e6a7c5e6b7e8d9e0f1a2b3c4d5e6f7a8 10.1.0.6:6379@16379 slave 67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 0 1538428698000 5 connected
a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 10.1.0.7:6379@16379 slave 292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f 0 1538428698000 6 connected`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
				"10.1.0.3": "pod-1.service.ns.svc.cluster.local:6379",
				"10.1.0.4": "pod-2.service.ns.svc.cluster.local:6379",
				"10.1.0.5": "pod-3.service.ns.svc.cluster.local:6379",
				"10.1.0.6": "pod-4.service.ns.svc.cluster.local:6379",
				"10.1.0.7": "pod-5.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN:       "pod-0.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.2",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 0, End: 5460}},
						Connected:  true,
					},
					{
						ID:         "67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1",
						FQDN:       "pod-1.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.3",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 5461, End: 10922}},
						Connected:  true,
					},
					{
						ID:         "292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f",
						FQDN:       "pod-2.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.4",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 10923, End: 16383}},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{
					{
						ID:        "e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca",
						FQDN:      "pod-3.service.ns.svc.cluster.local:6379",
						Host:      "10.1.0.5",
						Port:      6379,
						Role:      NodeRoleSlave,
						MasterID:  "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						Connected: true,
					},
					{
						ID:        "c8e7e5c5e6a7c5e6b7e8d9e0f1a2b3c4d5e6f7a8",
						FQDN:      "pod-4.service.ns.svc.cluster.local:6379",
						Host:      "10.1.0.6",
						Port:      6379,
						Role:      NodeRoleSlave,
						MasterID:  "67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1",
						Connected: true,
					},
					{
						ID:        "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
						FQDN:      "pod-5.service.ns.svc.cluster.local:6379",
						Host:      "10.1.0.7",
						Port:      6379,
						Role:      NodeRoleSlave,
						MasterID:  "292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f",
						Connected: true,
					},
				},
				Nodes: map[string]*ClusterNode{},
			},
		},
		{
			name: "healthy cluster - valkey style (replica)",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected 0-5460
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 10.1.0.3:6379@16379 master - 0 1538428699000 2 connected 5461-10922
e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca 10.1.0.5:6379@16379 replica 07c37dfeb235213a872192d05877c5d02d9a7e1f 0 1538428699000 4 connected`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
				"10.1.0.3": "pod-1.service.ns.svc.cluster.local:6379",
				"10.1.0.5": "pod-2.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN:       "pod-0.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.2",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 0, End: 5460}},
						Connected:  true,
					},
					{
						ID:         "67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1",
						FQDN:       "pod-1.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.3",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 5461, End: 10922}},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{
					{
						ID:        "e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca",
						FQDN:      "pod-2.service.ns.svc.cluster.local:6379",
						Host:      "10.1.0.5",
						Port:      6379,
						Role:      NodeRoleSlave,
						MasterID:  "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						Connected: true,
					},
				},
				Nodes: map[string]*ClusterNode{},
			},
		},
		{
			name: "cluster not bootstrapped - nodes joined but no slots",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 10.1.0.3:6379@16379 master - 0 1538428699000 2 connected
292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f 10.1.0.4:6379@16379 master - 0 1538428697000 3 connected`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
				"10.1.0.3": "pod-1.service.ns.svc.cluster.local:6379",
				"10.1.0.4": "pod-2.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN:       "pod-0.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.2",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{},
						Connected:  true,
					},
					{
						ID:         "67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1",
						FQDN:       "pod-1.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.3",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{},
						Connected:  true,
					},
					{
						ID:         "292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f",
						FQDN:       "pod-2.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.4",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name:              "single node not in cluster mode",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f :0@0 myself,master - 0 0 0 connected`,
			fqdnMap:           map[string]string{},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN:       "",
						Host:       "",
						Port:       0,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name: "unhealthy cluster - disconnected nodes",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected 0-5460
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 10.1.0.3:6379@16379 master - 0 1538428699000 2 disconnected 5461-10922
e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca 10.1.0.5:6379@16379 slave 07c37dfeb235213a872192d05877c5d02d9a7e1f 0 1538428699000 4 disconnected`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
				"10.1.0.3": "pod-1.service.ns.svc.cluster.local:6379",
				"10.1.0.5": "pod-2.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN:       "pod-0.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.2",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 0, End: 5460}},
						Connected:  true,
					},
					{
						ID:         "67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1",
						FQDN:       "pod-1.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.3",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 5461, End: 10922}},
						Connected:  false,
					},
				},
				Replicas: []*ClusterNode{
					{
						ID:        "e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca",
						FQDN:      "pod-2.service.ns.svc.cluster.local:6379",
						Host:      "10.1.0.5",
						Port:      6379,
						Role:      NodeRoleSlave,
						MasterID:  "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						Connected: false,
					},
				},
				Nodes: map[string]*ClusterNode{},
			},
		},
		{
			name: "cluster with fail flags",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master,fail - 0 1538428698000 1 connected 0-5460
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 10.1.0.3:6379@16379 master - 0 1538428699000 2 connected 5461-10922`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
				"10.1.0.3": "pod-1.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN:       "pod-0.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.2",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 0, End: 5460}},
						Connected:  true,
					},
					{
						ID:         "67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1",
						FQDN:       "pod-1.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.3",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 5461, End: 10922}},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name: "cluster with importing/migrating slots",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected 0-5460 [1000-<-67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1]
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 10.1.0.3:6379@16379 master - 0 1538428699000 2 connected 5461-10922 [1000->-07c37dfeb235213a872192d05877c5d02d9a7e1f]`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
				"10.1.0.3": "pod-1.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN:       "pod-0.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.2",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 0, End: 5460}},
						Connected:  true,
					},
					{
						ID:         "67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1",
						FQDN:       "pod-1.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.3",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 5461, End: 10922}},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name:              "cluster with single slot assignments",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected 0 5 10-20 100`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:   "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN: "pod-0.service.ns.svc.cluster.local:6379",
						Host: "10.1.0.2",
						Port: 6379,
						Role: NodeRoleMaster,
						SlotRanges: []SlotRange{
							{Start: 0, End: 0},
							{Start: 5, End: 5},
							{Start: 10, End: 20},
							{Start: 100, End: 100},
						},
						Connected: true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name: "cluster with myself flag",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 myself,master - 0 0 1 connected 0-5460
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 10.1.0.3:6379@16379 master - 0 1538428699000 2 connected 5461-10922`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
				"10.1.0.3": "pod-1.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN:       "pod-0.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.2",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 0, End: 5460}},
						Connected:  true,
					},
					{
						ID:         "67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1",
						FQDN:       "pod-1.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.3",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 5461, End: 10922}},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name:              "empty output",
			clusterNodeOutput: "",
			fqdnMap:           map[string]string{},
			want: &ClusterTopology{
				Masters:  []*ClusterNode{},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name:              "whitespace only output",
			clusterNodeOutput: "   \n\n   \n",
			fqdnMap:           map[string]string{},
			want: &ClusterTopology{
				Masters:  []*ClusterNode{},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name: "malformed line - insufficient fields",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 10.1.0.3:6379@16379 master - 0 1538428699000 2 connected 5461-10922`,
			fqdnMap: map[string]string{
				"10.1.0.3": "pod-1.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1",
						FQDN:       "pod-1.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.3",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 5461, End: 10922}},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name: "partial cluster - only 2 of 3 masters with slots",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected 0-8191
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 10.1.0.3:6379@16379 master - 0 1538428699000 2 connected 8192-16383
292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f 10.1.0.4:6379@16379 master - 0 1538428697000 3 connected`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
				"10.1.0.3": "pod-1.service.ns.svc.cluster.local:6379",
				"10.1.0.4": "pod-2.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN:       "pod-0.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.2",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 0, End: 8191}},
						Connected:  true,
					},
					{
						ID:         "67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1",
						FQDN:       "pod-1.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.3",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 8192, End: 16383}},
						Connected:  true,
					},
					{
						ID:         "292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f",
						FQDN:       "pod-2.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.4",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name: "cluster with handshake flag",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected 0-5460
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 10.1.0.3:6379@16379 master,handshake - 0 1538428699000 2 connected`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
				"10.1.0.3": "pod-1.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN:       "pod-0.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.2",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 0, End: 5460}},
						Connected:  true,
					},
					{
						ID:         "67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1",
						FQDN:       "pod-1.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.3",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name:              "master with multiple slot ranges",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected 0-1000 2000-3000 5000-6000`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:   "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN: "pod-0.service.ns.svc.cluster.local:6379",
						Host: "10.1.0.2",
						Port: 6379,
						Role: NodeRoleMaster,
						SlotRanges: []SlotRange{
							{Start: 0, End: 1000},
							{Start: 2000, End: 3000},
							{Start: 5000, End: 6000},
						},
						Connected: true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name: "mixed redis and valkey replica names",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected 0-8191
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 10.1.0.3:6379@16379 master - 0 1538428699000 2 connected 8192-16383
e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca 10.1.0.5:6379@16379 slave 07c37dfeb235213a872192d05877c5d02d9a7e1f 0 1538428699000 4 connected
c8e7e5c5e6a7c5e6b7e8d9e0f1a2b3c4d5e6f7a8 10.1.0.6:6379@16379 replica 67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 0 1538428698000 5 connected`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
				"10.1.0.3": "pod-1.service.ns.svc.cluster.local:6379",
				"10.1.0.5": "pod-2.service.ns.svc.cluster.local:6379",
				"10.1.0.6": "pod-3.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN:       "pod-0.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.2",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 0, End: 8191}},
						Connected:  true,
					},
					{
						ID:         "67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1",
						FQDN:       "pod-1.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.3",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 8192, End: 16383}},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{
					{
						ID:        "e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca",
						FQDN:      "pod-2.service.ns.svc.cluster.local:6379",
						Host:      "10.1.0.5",
						Port:      6379,
						Role:      NodeRoleSlave,
						MasterID:  "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						Connected: true,
					},
					{
						ID:        "c8e7e5c5e6a7c5e6b7e8d9e0f1a2b3c4d5e6f7a8",
						FQDN:      "pod-3.service.ns.svc.cluster.local:6379",
						Host:      "10.1.0.6",
						Port:      6379,
						Role:      NodeRoleSlave,
						MasterID:  "67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1",
						Connected: true,
					},
				},
				Nodes: map[string]*ClusterNode{},
			},
		},
		{
			name: "cluster with noaddr flag (node without address)",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected 0-5460
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 :0@0 master,noaddr - 1538428699000 2 disconnected`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN:       "pod-0.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.2",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 0, End: 5460}},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name: "malformed port number - should skip node",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:abc@16379 master - 0 1538428698000 1 connected 0-5460
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 10.1.0.3:6379@16379 master - 0 1538428699000 2 connected 5461-10922`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
				"10.1.0.3": "pod-1.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1",
						FQDN:       "pod-1.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.3",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 5461, End: 10922}},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name:              "malformed slot range - should skip invalid slots",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected 0-abc 100-200`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN:       "pod-0.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.2",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 100, End: 200}},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name:              "slot range with invalid format - should skip",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected 0--100 200-300`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN:       "pod-0.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.2",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 200, End: 300}},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name:              "slot out of range - should skip",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected 0-100 20000 200-300`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:   "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN: "pod-0.service.ns.svc.cluster.local:6379",
						Host: "10.1.0.2",
						Port: 6379,
						Role: NodeRoleMaster,
						SlotRanges: []SlotRange{
							{Start: 0, End: 100},
							{Start: 200, End: 300},
						},
						Connected: true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name:              "slot range reversed (start > end) - should skip",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected 100-0 200-300`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN:       "pod-0.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.2",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 200, End: 300}},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name:              "negative slot number - should skip",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected -1 0-100`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN:       "pod-0.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.2",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 0, End: 100}},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name:              "slot at max boundary (16383) - should accept",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected 16380-16383`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN:       "pod-0.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.2",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 16380, End: 16383}},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
		{
			name:              "slot above max boundary (16384) - should skip",
			clusterNodeOutput: `07c37dfeb235213a872192d05877c5d02d9a7e1f 10.1.0.2:6379@16379 master - 0 1538428698000 1 connected 0-100 16384`,
			fqdnMap: map[string]string{
				"10.1.0.2": "pod-0.service.ns.svc.cluster.local:6379",
			},
			want: &ClusterTopology{
				Masters: []*ClusterNode{
					{
						ID:         "07c37dfeb235213a872192d05877c5d02d9a7e1f",
						FQDN:       "pod-0.service.ns.svc.cluster.local:6379",
						Host:       "10.1.0.2",
						Port:       6379,
						Role:       NodeRoleMaster,
						SlotRanges: []SlotRange{{Start: 0, End: 100}},
						Connected:  true,
					},
				},
				Replicas: []*ClusterNode{},
				Nodes:    map[string]*ClusterNode{},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			parsedClusterNodes, err := r.parseClusterNodes(test.clusterNodeOutput, test.fqdnMap)
			if err != nil {
				t.Fatalf("parseClusterNodes() unexpected error = %v", err)
			}

			if parsedClusterNodes == nil && test.want == nil {
				return
			}

			if (parsedClusterNodes == nil) != (test.want == nil) {
				t.Errorf("parseClusterNodes() got = %+v, want %+v", parsedClusterNodes, test.want)
				return
			}

			if len(parsedClusterNodes.Masters) != len(test.want.Masters) {
				t.Errorf("Masters count: got %d, want %d", len(parsedClusterNodes.Masters), len(test.want.Masters))
			}

			if len(parsedClusterNodes.Replicas) != len(test.want.Replicas) {
				t.Errorf("Replicas count: got %d, want %d", len(parsedClusterNodes.Replicas), len(test.want.Replicas))
			}

			expectedNodeCount := len(test.want.Masters) + len(test.want.Replicas)
			if len(parsedClusterNodes.Nodes) != expectedNodeCount {
				t.Errorf("Nodes count: got %d, want %d", len(parsedClusterNodes.Nodes), expectedNodeCount)
			}

			for i, gotMaster := range parsedClusterNodes.Masters {
				if i >= len(test.want.Masters) {
					break
				}
				wantMaster := test.want.Masters[i]

				if gotMaster.SlotRanges == nil {
					gotMaster.SlotRanges = []SlotRange{}
				}
				if wantMaster.SlotRanges == nil {
					wantMaster.SlotRanges = []SlotRange{}
				}

				if !reflect.DeepEqual(*gotMaster, *wantMaster) {
					t.Errorf("Master[%d] mismatch:\ngot:  %+v\nwant: %+v", i, *gotMaster, *wantMaster)
				}
			}

			for i, gotReplica := range parsedClusterNodes.Replicas {
				if i >= len(test.want.Replicas) {
					break
				}
				wantReplica := test.want.Replicas[i]

				if gotReplica.SlotRanges == nil {
					gotReplica.SlotRanges = []SlotRange{}
				}
				if wantReplica.SlotRanges == nil {
					wantReplica.SlotRanges = []SlotRange{}
				}

				if !reflect.DeepEqual(*gotReplica, *wantReplica) {
					t.Errorf("Replica[%d] mismatch:\ngot:  %+v\nwant: %+v", i, *gotReplica, *wantReplica)
				}
			}
		})
	}
}
