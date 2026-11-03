package provisioning

import (
	_ "embed"
	"encoding/json"
)

// The descriptive half of the catalog: what each offering is, which kind its
// operator serves and where that operator lives. Presets describe sizing
// intent only; they do not establish replica counts, placement, persistence or
// backups on a discovered cluster. Names are the product a user has heard of
// ("PostgreSQL"), never the operator.

type OperatorRef struct {
	// An exact name or a prefix (Helm prepends the release name).
	Deployment string `json:"deployment"`
	// Every one of these labels, as an alternative to the name.
	Labels map[string]string `json:"labels,omitempty"`
}

type GroupResource struct {
	Group    string `json:"group"`
	Resource string `json:"resource"`
}

type OfferingSpec struct {
	ID      OfferingID `json:"id"`
	Name    string     `json:"name"`
	Purpose Purpose    `json:"purpose"`
	What    string     `json:"what"`
	GoodFor []string   `json:"goodFor"`
	// Discovery key, with supported versions preferred first; intersected with
	// what the cluster serves.
	Group       string       `json:"group"`
	Kind        string       `json:"kind"`
	Versions    []string     `json:"versions"`
	Operator    OperatorInfo `json:"operator"`
	OperatorRef OperatorRef  `json:"operatorRef"`
	// Resources the sample manifest creates besides the primary kind, so the
	// create verdict covers the whole apply.
	AlsoRequires []GroupResource `json:"alsoRequires"`
	// The label an instance's own pods carry, for network-policy coverage.
	InstanceLabelKey       string   `json:"instanceLabelKey"`
	StorageClassPreference []string `json:"storageClassPreference"`
	Presets                []Preset `json:"presets"`
	// Rendered on a not-installed card so it is never a dead end.
	Needs    []string `json:"needs"`
	Stateful bool     `json:"stateful"`
}

//go:embed offerings.json
var offeringsJSON []byte

// Offerings is the catalog, in display order.
var Offerings = func() []OfferingSpec {
	var specs []OfferingSpec
	if err := json.Unmarshal(offeringsJSON, &specs); err != nil {
		panic(err)
	}

	return specs
}()

// OfferingIDs lists the catalog's IDs in display order.
var OfferingIDs = func() []OfferingID {
	ids := make([]OfferingID, len(Offerings))
	for i, o := range Offerings {
		ids[i] = o.ID
	}

	return ids
}()

func OfferingByID(id OfferingID) (OfferingSpec, bool) {
	for _, o := range Offerings {
		if o.ID == id {
			return o, true
		}
	}

	return OfferingSpec{}, false
}
