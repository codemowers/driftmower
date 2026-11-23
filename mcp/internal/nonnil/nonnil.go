// Package nonnil keeps JSON output stable: empty collections encode as []
// or {} and empty strings as null.
package nonnil

func Slice[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

func Map[M ~map[K]V, K comparable, V any](m M) M {
	if m == nil {
		return M{}
	}
	return m
}

func String(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
