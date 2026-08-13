package budget

const (
	// AcceptedBytesPerMachinePerMinute is the canonical protobuf accepted by one
	// gateway Machine. The gateway applies this after schema validation.
	AcceptedBytesPerMachinePerMinute = 32 * 1024
	AccountingDays                   = 31
	ProductionMachineCount           = 2

	// SafeMonthlyCanonicalBytes is an internal ceiling, not Grafana capacity.
	// It deliberately leaves substantial distance to both operator alerts.
	SafeMonthlyCanonicalBytes int64 = 3_000_000_000
	UsageWarningBytes         int64 = 10_000_000_000
	UsageShutdownBytes        int64 = 20_000_000_000
	GrafanaFreeMonthlyBytes   int64 = 50_000_000_000
)

// MaximumMonthlyCanonicalBytes returns the accepted canonical protobuf upper
// bound for the supplied number of concurrently routable Machines.
func MaximumMonthlyCanonicalBytes(machineCount int) int64 {
	if machineCount <= 0 {
		return 0
	}
	return int64(AcceptedBytesPerMachinePerMinute) * int64(machineCount) * AccountingDays * 24 * 60
}
