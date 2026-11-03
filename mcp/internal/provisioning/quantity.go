package provisioning

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Kubernetes quantity strings, parsed the way the API server means them. Quota
// headroom is arithmetic on .status.hard minus .status.used, and both are
// strings like "2Gi", "100m" or "1".
//
// Binary suffixes (1Ki = 1024) and decimal ones (1k = 1000) differ, and mixing
// them up understates a quota by 7% at Gi scale.
var binarySuffixes = map[string]float64{
	"Ki": 1 << 10, "Mi": 1 << 20, "Gi": 1 << 30, "Ti": 1 << 40, "Pi": 1 << 50, "Ei": 1 << 60,
}

var decimalSuffixes = map[string]float64{
	"n": 1e-9, "u": 1e-6, "m": 1e-3, "": 1, "k": 1e3, "M": 1e6, "G": 1e9, "T": 1e12, "P": 1e15, "E": 1e18,
}

// Binary suffixes take an uppercase letter plus "i"; decimal ones are a single
// letter with lowercase "k" for kilo. So "Ki" is valid and "ki" is not.
var quantityPattern = regexp.MustCompile(`^(-?(?:\d+\.?\d*|\.\d+))((?:[KMGTPE]i)|(?:[numkMGTPE])|)$`)

// ParseQuantity reports false rather than 0 for anything unparseable: an
// unreadable number must not silently become "no usage".
func ParseQuantity(value string) (float64, bool) {
	match := quantityPattern.FindStringSubmatch(strings.TrimSpace(value))
	if match == nil {
		return 0, false
	}
	amount, err := strconv.ParseFloat(match[1], 64)
	if err != nil || math.IsInf(amount, 0) {
		return 0, false
	}
	if m, ok := binarySuffixes[match[2]]; ok {
		return amount * m, true
	}

	return amount * decimalSuffixes[match[2]], true
}

// jsRound rounds half towards positive infinity, like Math.round.
func jsRound(x float64) int64 {
	return int64(math.Floor(x + 0.5))
}

// ParseCPUMillis keeps CPU in integer millicores, as the API quotes it.
func ParseCPUMillis(value string) (int64, bool) {
	v, ok := ParseQuantity(value)

	return jsRound(v * 1000), ok
}

func ParseCount(value string) (int64, bool) {
	v, ok := ParseQuantity(value)

	return jsRound(v), ok
}
