package main

import (
	"strings"
	"testing"
)

func TestVerifyMachineInventory(t *testing.T) {
	tests := []struct {
		name      string
		inventory string
		wantError string
	}{
		{name: "budgeted production inventory", inventory: `[{"id":"opaque-one","state":"started"},{"id":"opaque-two","state":"started"}]`},
		{name: "too few Machines", inventory: `[{"state":"started"}]`, wantError: "requires exactly 2"},
		{name: "too many Machines", inventory: `[{"state":"started"},{"state":"started"},{"state":"started"}]`, wantError: "requires exactly 2"},
		{name: "stopped Machine", inventory: `[{"state":"started"},{"state":"stopped"}]`, wantError: "must be started"},
		{name: "malformed", inventory: `{}`, wantError: "invalid"},
		{name: "trailing data", inventory: `[{"state":"started"},{"state":"started"}] []`, wantError: "trailing"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			count, verificationError := verifyMachineInventory(strings.NewReader(test.inventory))
			if test.wantError == "" {
				if verificationError != nil {
					t.Fatal(verificationError)
				}
				if count != 2 {
					t.Fatalf("verified Machine count = %d, want 2", count)
				}
				return
			}
			if verificationError == nil || !strings.Contains(verificationError.Error(), test.wantError) {
				t.Fatalf("verification error = %v, want substring %q", verificationError, test.wantError)
			}
		})
	}
}
