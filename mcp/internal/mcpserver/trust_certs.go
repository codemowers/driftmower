package mcpserver

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"
)

type certFinding struct {
	// critical: trust in this anchor is unsafe; warning: violates current
	// practice; info: worth knowing.
	Severity string `json:"severity"`
	Code     string `json:"code"`
	Message  string `json:"message"`
}

type nameConstraints struct {
	Critical          bool     `json:"critical"`
	PermittedDNS      []string `json:"permittedDNS,omitempty"`
	ExcludedDNS       []string `json:"excludedDNS,omitempty"`
	PermittedIPRanges []string `json:"permittedIPRanges,omitempty"`
	ExcludedIPRanges  []string `json:"excludedIPRanges,omitempty"`
	PermittedEmail    []string `json:"permittedEmail,omitempty"`
	ExcludedEmail     []string `json:"excludedEmail,omitempty"`
	PermittedURI      []string `json:"permittedURIDomains,omitempty"`
	ExcludedURI       []string `json:"excludedURIDomains,omitempty"`
}

type trustCertificate struct {
	Subject            string           `json:"subject"`
	Issuer             string           `json:"issuer"`
	Serial             string           `json:"serial"`
	SerialBits         int              `json:"serialBits"`
	Version            int              `json:"version"`
	NotBefore          time.Time        `json:"notBefore"`
	NotAfter           time.Time        `json:"notAfter"`
	SHA256             string           `json:"sha256"`
	PublicKey          string           `json:"publicKey"`
	SignatureAlgorithm string           `json:"signatureAlgorithm"`
	IsCA               bool             `json:"isCA"`
	MaxPathLen         *int             `json:"maxPathLen,omitempty"`
	KeyUsage           []string         `json:"keyUsage"`
	ExtKeyUsage        []string         `json:"extKeyUsage,omitempty"`
	SubjectKeyID       string           `json:"subjectKeyId,omitempty"`
	AuthorityKeyID     string           `json:"authorityKeyId,omitempty"`
	NameConstraints    *nameConstraints `json:"nameConstraints,omitempty"`
	SelfSigned         bool             `json:"selfSigned"`
	Expired            bool             `json:"expired"`
	NotYetValid        bool             `json:"notYetValid"`
	Findings           []certFinding    `json:"findings"`
}

func describeCertificate(cert *x509.Certificate, now time.Time) trustCertificate {
	sum := sha256.Sum256(cert.Raw)
	c := trustCertificate{
		Subject:            cert.Subject.String(),
		Issuer:             cert.Issuer.String(),
		Serial:             cert.SerialNumber.Text(16),
		SerialBits:         cert.SerialNumber.BitLen(),
		Version:            cert.Version,
		NotBefore:          cert.NotBefore,
		NotAfter:           cert.NotAfter,
		SHA256:             hex.EncodeToString(sum[:]),
		PublicKey:          publicKeyLabel(cert.PublicKey),
		SignatureAlgorithm: cert.SignatureAlgorithm.String(),
		IsCA:               cert.IsCA,
		KeyUsage:           keyUsages(cert.KeyUsage),
		SubjectKeyID:       hex.EncodeToString(cert.SubjectKeyId),
		AuthorityKeyID:     hex.EncodeToString(cert.AuthorityKeyId),
		NameConstraints:    constraintsOf(cert),
		SelfSigned:         selfSigned(cert),
		Expired:            now.After(cert.NotAfter),
		NotYetValid:        now.Before(cert.NotBefore),
	}
	if cert.BasicConstraintsValid && cert.IsCA && (cert.MaxPathLen > 0 || cert.MaxPathLenZero) {
		n := cert.MaxPathLen
		c.MaxPathLen = &n
	}
	for _, u := range cert.ExtKeyUsage {
		c.ExtKeyUsage = append(c.ExtKeyUsage, extKeyUsageName(u))
	}
	c.Findings = lintCertificate(cert, c)
	return c
}

// selfSigned also accepts SHA-1 and MD5 self-signatures, which Go refuses to
// verify but legacy roots still carry.
func selfSigned(cert *x509.Certificate) bool {
	if !bytes.Equal(cert.RawSubject, cert.RawIssuer) {
		return false
	}
	err := cert.CheckSignatureFrom(cert)
	var insecure x509.InsecureAlgorithmError
	return err == nil || errors.As(err, &insecure)
}

func lintCertificate(cert *x509.Certificate, c trustCertificate) []certFinding {
	f := []certFinding{}
	add := func(severity, code, format string, args ...any) {
		f = append(f, certFinding{Severity: severity, Code: code, Message: fmt.Sprintf(format, args...)})
	}
	switch key := cert.PublicKey.(type) {
	case *ecdsa.PublicKey:
		if k, ok := smallScalar(key); ok {
			add("critical", "weak-ec-private-key", "The private key is recoverable: the public key is %d·G on %s, so its private scalar is ±%d. This is the eMudhra 2025 failure mode (Bugzilla 2083449).", k, key.Curve.Params().Name, k)
		}
	case *rsa.PublicKey:
		if bits := key.N.BitLen(); bits < 2048 {
			add("critical", "weak-rsa-modulus", "The RSA modulus is %d bits; at least 2048 is required.", bits)
		}
		switch {
		case key.E < 3 || key.E%2 == 0:
			add("critical", "weak-rsa-exponent", "The RSA public exponent %d is invalid; it must be odd and at least 3.", key.E)
		case key.E < 65537:
			add("warning", "small-rsa-exponent", "The RSA public exponent is %d; the Baseline Requirements recommend 65537 or larger.", key.E)
		}
	}
	switch serial := cert.SerialNumber; {
	case serial.Sign() <= 0:
		add("warning", "non-positive-serial", "The serial number is %s; RFC 5280 requires a positive integer.", serial.String())
	case serial.BitLen() < 64:
		// Ballot 164 is not retroactive: older roots legitimately carry short serials.
		severity, when := "info", "predates the 2016-09-30 requirement"
		if !cert.NotBefore.Before(serialEntropyRequired) {
			severity, when = "warning", "violates the requirement in force since 2016-09-30"
		}
		detail := ""
		if serial.BitLen() == 63 || serial.BitLen() == 62 {
			detail = " A 62–63-bit serial is the signature of 64-bit generators that forced the top bit positive, the 2019 serial-entropy incidents."
		}
		add(severity, "short-serial", "The serial number has %d significant bits; the CA/Browser Forum requires at least 64 bits of CSPRNG output. This certificate %s.%s", serial.BitLen(), when, detail)
	}
	if len(cert.SerialNumber.Bytes()) > 20 {
		add("warning", "long-serial", "The serial number is longer than the 20 octets RFC 5280 allows.")
	}
	// A trust anchor's own signature is not verified during path validation,
	// so a weak hash on a self-signed root is informational only.
	hashSeverity, hashNote := "warning", ""
	if c.SelfSigned {
		hashSeverity, hashNote = "info", " Validators do not check a root's self-signature."
	}
	switch cert.SignatureAlgorithm {
	case x509.MD2WithRSA, x509.MD5WithRSA:
		add(hashSeverity, "weak-signature-hash", "The certificate is signed with %s; MD5 signatures are forgeable.%s", cert.SignatureAlgorithm, hashNote)
	case x509.SHA1WithRSA, x509.DSAWithSHA1, x509.ECDSAWithSHA1:
		add(hashSeverity, "weak-signature-hash", "The certificate is signed with %s; SHA-1 is deprecated.%s", cert.SignatureAlgorithm, hashNote)
	}
	if !cert.BasicConstraintsValid || !cert.IsCA {
		add("critical", "not-a-ca", "The certificate is not marked as a CA (basicConstraints cA=TRUE), yet it is distributed as a trust anchor.")
	}
	if cert.KeyUsage != 0 && cert.KeyUsage&x509.KeyUsageCertSign == 0 {
		add("warning", "no-cert-sign", "Key usage does not include keyCertSign.")
	} else if cert.KeyUsage == 0 {
		add("info", "no-key-usage", "The certificate has no key usage extension.")
	}
	if c.Expired {
		add("warning", "expired", "Expired on %s; it still occupies the bundle but can no longer anchor valid chains.", cert.NotAfter.Format("2006-01-02"))
	}
	if cert.Version != 3 {
		add("info", "old-version", "X.509 version %d; version 3 is expected.", cert.Version)
	}
	if years := cert.NotAfter.Sub(cert.NotBefore).Hours() / 24 / 365.25; years > 30 {
		add("info", "long-validity", "Valid for %.0f years.", years)
	}
	return f
}

// CA/Browser Forum Ballot 164: serials carry at least 64 bits of CSPRNG output.
var serialEntropyRequired = time.Date(2016, 9, 30, 0, 0, 0, 0, time.UTC)

// Small private scalars are recovered by matching the public point against k·G.
const smallScalarLimit = 1 << 16

var smallScalarTables sync.Map // curve name → *scalarTable

type scalarTable struct {
	once sync.Once
	byX  map[string]int
}

// smallScalar reports k when the public key is ±k·G for 1 ≤ k ≤ smallScalarLimit.
func smallScalar(key *ecdsa.PublicKey) (int, bool) {
	if key == nil || key.Curve == nil {
		return 0, false
	}
	point, err := key.Bytes()
	if err != nil {
		return 0, false
	}
	name := key.Curve.Params().Name
	v, _ := smallScalarTables.LoadOrStore(name, &scalarTable{})
	t := v.(*scalarTable)
	t.once.Do(func() { t.byX = buildScalarTable(key.Curve) })
	// SEC 1 uncompressed points contain a prefix followed by fixed-width X and Y.
	x := bytes.TrimLeft(point[1:1+(len(point)-1)/2], "\x00")
	k, ok := t.byX[string(x)]
	return k, ok
}

// buildScalarTable walks G, 2G, … by point addition. The deprecated generic
// point arithmetic is the only public API for adding points.
func buildScalarTable(curve elliptic.Curve) map[string]int {
	p := curve.Params()
	table := make(map[string]int, smallScalarLimit)
	x, y := new(big.Int).Set(p.Gx), new(big.Int).Set(p.Gy)
	for k := 1; k <= smallScalarLimit; k++ {
		table[string(x.Bytes())] = k
		x, y = curve.Add(x, y, p.Gx, p.Gy) //nolint:staticcheck // no non-deprecated public point addition
	}
	return table
}

func publicKeyLabel(key any) string {
	switch k := key.(type) {
	case *rsa.PublicKey:
		return fmt.Sprintf("RSA %d", k.N.BitLen())
	case *ecdsa.PublicKey:
		return "ECDSA " + k.Curve.Params().Name
	case ed25519.PublicKey:
		return "Ed25519"
	default:
		return fmt.Sprintf("%T", key)
	}
}

var keyUsageNames = []struct {
	bit  x509.KeyUsage
	name string
}{
	{x509.KeyUsageDigitalSignature, "digitalSignature"},
	{x509.KeyUsageContentCommitment, "contentCommitment"},
	{x509.KeyUsageKeyEncipherment, "keyEncipherment"},
	{x509.KeyUsageDataEncipherment, "dataEncipherment"},
	{x509.KeyUsageKeyAgreement, "keyAgreement"},
	{x509.KeyUsageCertSign, "keyCertSign"},
	{x509.KeyUsageCRLSign, "cRLSign"},
	{x509.KeyUsageEncipherOnly, "encipherOnly"},
	{x509.KeyUsageDecipherOnly, "decipherOnly"},
}

func keyUsages(u x509.KeyUsage) []string {
	out := []string{}
	for _, k := range keyUsageNames {
		if u&k.bit != 0 {
			out = append(out, k.name)
		}
	}
	return out
}

func extKeyUsageName(u x509.ExtKeyUsage) string {
	switch u {
	case x509.ExtKeyUsageAny:
		return "any"
	case x509.ExtKeyUsageServerAuth:
		return "serverAuth"
	case x509.ExtKeyUsageClientAuth:
		return "clientAuth"
	case x509.ExtKeyUsageCodeSigning:
		return "codeSigning"
	case x509.ExtKeyUsageEmailProtection:
		return "emailProtection"
	case x509.ExtKeyUsageTimeStamping:
		return "timeStamping"
	case x509.ExtKeyUsageOCSPSigning:
		return "OCSPSigning"
	default:
		return fmt.Sprintf("eku-%d", u)
	}
}

func constraintsOf(cert *x509.Certificate) *nameConstraints {
	nc := &nameConstraints{
		Critical:       cert.PermittedDNSDomainsCritical,
		PermittedDNS:   cert.PermittedDNSDomains,
		ExcludedDNS:    cert.ExcludedDNSDomains,
		PermittedEmail: cert.PermittedEmailAddresses,
		ExcludedEmail:  cert.ExcludedEmailAddresses,
		PermittedURI:   cert.PermittedURIDomains,
		ExcludedURI:    cert.ExcludedURIDomains,
	}
	for _, r := range cert.PermittedIPRanges {
		nc.PermittedIPRanges = append(nc.PermittedIPRanges, r.String())
	}
	for _, r := range cert.ExcludedIPRanges {
		nc.ExcludedIPRanges = append(nc.ExcludedIPRanges, r.String())
	}
	if len(nc.PermittedDNS)+len(nc.ExcludedDNS)+len(nc.PermittedEmail)+len(nc.ExcludedEmail)+
		len(nc.PermittedURI)+len(nc.ExcludedURI)+len(nc.PermittedIPRanges)+len(nc.ExcludedIPRanges) == 0 {
		return nil
	}
	return nc
}
