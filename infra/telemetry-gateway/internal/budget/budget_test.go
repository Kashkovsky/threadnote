package budget

import (
	"testing"
	"testing/quick"
)

func TestProductionBudgetStaysBelowEveryFreePlanGate(t *testing.T) {
	maximum := MaximumMonthlyCanonicalBytes(ProductionMachineCount)
	if maximum != 2_925_527_040 {
		t.Fatalf("monthly canonical byte cap = %d, want 2925527040", maximum)
	}
	if maximum >= SafeMonthlyCanonicalBytes {
		t.Fatalf("monthly canonical byte cap = %d, must remain below %d", maximum, SafeMonthlyCanonicalBytes)
	}
	if !(SafeMonthlyCanonicalBytes < UsageWarningBytes &&
		UsageWarningBytes < UsageShutdownBytes &&
		UsageShutdownBytes < GrafanaFreeMonthlyBytes) {
		t.Fatal("free-plan ceilings must remain strictly ordered")
	}
}

func TestMonthlyAccountingIsLinearInTheMachineInventory(t *testing.T) {
	property := func(machineCount uint8) bool {
		count := int(machineCount)
		maximum := MaximumMonthlyCanonicalBytes(count)
		if count == 0 {
			return maximum == 0
		}
		return maximum == int64(count)*MaximumMonthlyCanonicalBytes(1) &&
			maximum > MaximumMonthlyCanonicalBytes(count-1)
	}
	if propertyError := quick.Check(property, &quick.Config{MaxCount: 128}); propertyError != nil {
		t.Fatal(propertyError)
	}
}
