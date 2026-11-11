package valkey

import (
	"context"
	"fmt"
	"slices"
	"strings"

	valkeygo "github.com/valkey-io/valkey-go"
)

func SetParameters(ctx context.Context, nodeClient valkeygo.Client, parameters map[string]string) error {
	if len(parameters) == 0 {
		return nil
	}

	names := make([]string, 0, len(parameters))
	configSetCmd := nodeClient.B().ConfigSet().ParameterValue()
	for name, value := range parameters {
		names = append(names, name)
		configSetCmd = configSetCmd.ParameterValue(name, value)
	}
	if err := nodeClient.Do(ctx, configSetCmd.Build()).Error(); err != nil {
		return err
	}

	// NOTE: Valkey normalizes values (100mb reads back as 104857600)
	appliedParameters, err := nodeClient.Do(ctx, nodeClient.B().ConfigGet().Parameter(names...).Build()).AsStrMap()
	if err != nil {
		return err
	}
	slices.Sort(names)
	for _, name := range names {
		appliedValue, exists := appliedParameters[name]
		if !exists {
			return fmt.Errorf("CONFIG GET %s returned nothing after CONFIG SET", name)
		}
		fmt.Printf("  %s %s\n", name, appliedValue)
	}
	return nil
}

func AddAdminPassword(ctx context.Context, nodeClient valkeygo.Client, adminPassword string) error {
	if err := nodeClient.Do(ctx, nodeClient.B().AclSetuser().Username(AdminUser).Rule(">"+adminPassword).Build()).Error(); err != nil {
		return fmt.Errorf("ACL SETUSER %s: %w", AdminUser, err)
	}
	if err := nodeClient.Do(ctx, nodeClient.B().ConfigSet().ParameterValue().ParameterValue("primaryauth", adminPassword).Build()).Error(); err != nil {
		return fmt.Errorf("CONFIG SET primaryauth: %w", err)
	}
	return nil
}

func SetUsers(ctx context.Context, nodeClient valkeygo.Client, usersACL string) error {
	usernames := make([]string, 0)
	for lineIndex, line := range strings.Split(usersACL, "\n") {
		// NOTE: Valkey splits aclfile lines on single spaces
		fields := strings.Split(strings.Trim(line, " \t\r"), " ")
		if fields[0] == "" {
			continue
		}
		if fields[0] != "user" || len(fields) < 2 {
			return fmt.Errorf("users.acl line %d doesn't start with user and a username", lineIndex+1)
		}

		username := fields[1]
		rules := append([]string{"reset"}, fields[2:]...)
		if err := nodeClient.Do(ctx, nodeClient.B().AclSetuser().Username(username).Rule(rules...).Build()).Error(); err != nil {
			return fmt.Errorf("ACL SETUSER %s: %w", username, err)
		}
		usernames = append(usernames, username)
	}

	existingUsernames, err := nodeClient.Do(ctx, nodeClient.B().AclUsers().Build()).AsStrSlice()
	if err != nil {
		return err
	}
	for _, existingUsername := range existingUsernames {
		if slices.Contains(usernames, existingUsername) {
			continue
		}
		if err := nodeClient.Do(ctx, nodeClient.B().AclDeluser().Username(existingUsername).Build()).Error(); err != nil {
			return fmt.Errorf("ACL DELUSER %s: %w", existingUsername, err)
		}
		fmt.Printf("  deleted user %s\n", existingUsername)
	}
	fmt.Printf("  users %v\n", usernames)
	return nil
}
