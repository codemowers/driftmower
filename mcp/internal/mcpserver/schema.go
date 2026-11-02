package mcpserver

import (
	"encoding/json"
	"reflect"

	"github.com/google/jsonschema-go/jsonschema"

	"github.com/codemowers/driftmower-mcp/internal/observability"
	"github.com/codemowers/driftmower-mcp/internal/provisioning"
)

// Types with custom JSON need their wire schema spelled out.
var typeSchemas = map[reflect.Type]*jsonschema.Schema{
	// A [timestamp, "value"] pair.
	reflect.TypeFor[observability.PromSample](): {Type: "array", MinItems: jsonschema.Ptr(2), MaxItems: jsonschema.Ptr(2)},
	reflect.TypeFor[provisioning.WatchedNamespaces](): {AnyOf: []*jsonschema.Schema{
		{Type: "array", Items: &jsonschema.Schema{Type: "string"}},
		{Type: "string", Enum: []any{"all"}},
	}},
	reflect.TypeFor[provisioning.Availability](): {
		Type:     "object",
		Required: []string{"state"},
		Properties: map[string]*jsonschema.Schema{
			"state":   {Type: "string", Enum: []any{provisioning.StateReady, provisioning.StateDegraded, provisioning.StateCRDsOnly, provisioning.StateNotInstalled}},
			"version": {Types: []string{"null", "string"}},
			"watchedNamespaces": {AnyOf: []*jsonschema.Schema{
				{Type: "array", Items: &jsonschema.Schema{Type: "string"}},
				{Type: "string", Enum: []any{"all"}},
			}},
			"reason":      {Type: "string"},
			"installHref": {Types: []string{"null", "string"}},
		},
	},
}

// schemaFor infers T's schema. Go maps marshal as null when nil, so map-typed
// objects also accept null.
//
// A pointer output is described by its element type, as the SDK does: MCP
// requires an output schema of type "object", and clients reject a nullable
// root.
func schemaFor[T any]() *jsonschema.Schema {
	rt := reflect.TypeFor[T]()
	if rt.Kind() == reflect.Pointer {
		rt = rt.Elem()
	}
	s, err := jsonschema.ForType(rt, &jsonschema.ForOptions{TypeSchemas: typeSchemas})
	if err != nil {
		panic(err)
	}
	nullableMaps(s)

	return s
}

func nullableMaps(s *jsonschema.Schema) {
	if s == nil {
		return
	}
	if s.Type == "object" && s.AdditionalProperties != nil && s.AdditionalProperties.Not == nil {
		s.Types, s.Type = []string{"null", "object"}, ""
	}
	nullableMaps(s.Items)
	nullableMaps(s.AdditionalProperties)
	for _, p := range s.Properties {
		nullableMaps(p)
	}
	for _, a := range s.AnyOf {
		nullableMaps(a)
	}
}

// inputSchema infers T's schema and lets the caller add constraints the Go
// type cannot express. Unknown arguments are ignored rather than rejected, so
// an agent passing a stray argument still gets an answer; wrap the schema in
// strict where an unexpected argument must fail the call.
func inputSchema[T any](constrain func(props map[string]*jsonschema.Schema)) *jsonschema.Schema {
	s, err := jsonschema.For[T](nil)
	if err != nil {
		panic(err)
	}
	s.AdditionalProperties = nil
	if constrain != nil {
		constrain(s.Properties)
	}

	return s
}

// noArguments is the input schema of a tool that takes no arguments; like
// inputSchema, it ignores any that are passed.
func noArguments() *jsonschema.Schema {
	return &jsonschema.Schema{Type: "object"}
}

// strict rejects arguments the schema does not name.
func strict(s *jsonschema.Schema) *jsonschema.Schema {
	s.AdditionalProperties = &jsonschema.Schema{Not: &jsonschema.Schema{}}

	return s
}

func enumOf[T ~string](values []T) []any {
	out := make([]any, len(values))
	for i, v := range values {
		out[i] = string(v)
	}

	return out
}

func defaultValue(v any) json.RawMessage {
	b, _ := json.Marshal(v)

	return b
}

const dnsLabelPattern = `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`

func namespaceProperty(s *jsonschema.Schema) {
	s.MinLength, s.MaxLength = jsonschema.Ptr(1), jsonschema.Ptr(63)
	s.Pattern = dnsLabelPattern
}
