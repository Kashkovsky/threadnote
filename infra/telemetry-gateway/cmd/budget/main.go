package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/Kashkovsky/threadnote/infra/telemetry-gateway/internal/budget"
)

type machine struct {
	State string `json:"state"`
}

func main() {
	machineCount, verificationError := verifyMachineInventory(os.Stdin)
	if verificationError != nil {
		_, _ = fmt.Fprintf(os.Stderr, "telemetry production budget check failed: %v\n", verificationError)
		os.Exit(1)
	}
	_, _ = fmt.Fprintf(
		os.Stdout,
		"telemetry production budget verified: %d started Machines, at most %d canonical bytes per %d days\n",
		machineCount,
		budget.MaximumMonthlyCanonicalBytes(machineCount),
		budget.AccountingDays,
	)
}

func verifyMachineInventory(input io.Reader) (int, error) {
	decoder := json.NewDecoder(io.LimitReader(input, 1024*1024))
	var machines []machine
	if decodeError := decoder.Decode(&machines); decodeError != nil {
		return 0, errors.New("invalid Fly Machine inventory JSON")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return 0, errors.New("Fly Machine inventory contains trailing data")
	}
	if len(machines) != budget.ProductionMachineCount {
		return len(machines), fmt.Errorf(
			"Machine inventory count is %d; budget requires exactly %d",
			len(machines),
			budget.ProductionMachineCount,
		)
	}
	for _, candidate := range machines {
		if !strings.EqualFold(candidate.State, "started") {
			return len(machines), errors.New("every budgeted Machine must be started")
		}
	}
	if budget.MaximumMonthlyCanonicalBytes(len(machines)) >= budget.SafeMonthlyCanonicalBytes {
		return len(machines), errors.New("Machine inventory exceeds the safe monthly canonical-byte ceiling")
	}
	return len(machines), nil
}
