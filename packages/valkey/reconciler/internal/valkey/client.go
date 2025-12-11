package valkey

import valkeygo "github.com/valkey-io/valkey-go"

const AdminUser = "admin"

type ValkeyClient struct {
	valkeygo.Client
	options valkeygo.ClientOption
}

func NewClient(options valkeygo.ClientOption) (*ValkeyClient, error) {
	client, err := valkeygo.NewClient(options)
	if err != nil {
		return nil, err
	}
	return &ValkeyClient{Client: client, options: options}, nil
}

func (v *ValkeyClient) Close() {
	v.Client.Close()
}

// When you refresh with hostnames, it will NOT mutate the original options meaning the next time you
// call Refresh, it will use the original options again.
func (v *ValkeyClient) Refresh(hostnames ...string) error {
	v.Close()

	options := v.options
	if len(hostnames) > 0 {
		options.InitAddress = hostnames
	}

	newClient, err := valkeygo.NewClient(options)
	if err != nil {
		return err
	}
	v.Client = newClient
	return nil
}
