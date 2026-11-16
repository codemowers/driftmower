package mcpserver

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"slices"
	"testing"
	"time"
)

var lintNow = time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC)

func selfSignedCA(t *testing.T, key crypto.Signer, serial *big.Int, edit func(*x509.Certificate)) *x509.Certificate {
	t.Helper()
	tmpl := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: "Test Root"},
		NotBefore: lintNow.Add(-time.Hour), NotAfter: lintNow.Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	if edit != nil {
		edit(tmpl)
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, key.Public(), key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return cert
}

func codes(c trustCertificate) []string {
	out := []string{}
	for _, f := range c.Findings {
		out = append(out, f.Severity+":"+f.Code)
	}
	return out
}

func randomSerial(t *testing.T) *big.Int {
	t.Helper()
	n, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		t.Fatal(err)
	}
	return n.SetBit(n, 126, 1)
}

func TestHealthyCAHasNoFindings(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	c := describeCertificate(selfSignedCA(t, key, randomSerial(t), nil), lintNow)
	if len(c.Findings) != 0 || c.PublicKey != "ECDSA P-384" || c.NameConstraints != nil || !c.SelfSigned {
		t.Fatalf("certificate = %+v", c)
	}
}

func TestSmallScalarECKeyIsCritical(t *testing.T) {
	// The eMudhra intermediates had private scalars between 4 and 247.
	curve := elliptic.P384()
	x, y := curve.ScalarBaseMult(big.NewInt(4).Bytes()) //nolint:staticcheck // building a deliberately weak key
	key := &ecdsa.PrivateKey{PublicKey: ecdsa.PublicKey{Curve: curve, X: x, Y: y}, D: big.NewInt(4)}
	c := describeCertificate(selfSignedCA(t, key, randomSerial(t), nil), lintNow)
	if !slices.Contains(codes(c), "critical:weak-ec-private-key") {
		t.Fatalf("findings = %v", codes(c))
	}
}

func TestWeakRSAAndShortSerial(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 1024)
	c := describeCertificate(selfSignedCA(t, key, big.NewInt(1), func(c *x509.Certificate) { c.NotAfter = lintNow.Add(-time.Minute) }), lintNow)
	got := codes(c)
	for _, want := range []string{"critical:weak-rsa-modulus", "warning:short-serial", "warning:expired"} { // issued after 2016-09-30
		if !slices.Contains(got, want) {
			t.Errorf("findings %v lack %s", got, want)
		}
	}
	if c.PublicKey != "RSA 1024" || c.SerialBits != 1 {
		t.Errorf("certificate = %+v", c)
	}
}

func TestNameConstraintsAreExposed(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	cert := selfSignedCA(t, key, randomSerial(t), func(c *x509.Certificate) {
		c.PermittedDNSDomainsCritical = true
		c.PermittedDNSDomains = []string{".codemowers.io"}
		c.ExcludedDNSDomains = []string{"evil.codemowers.io"}
	})
	nc := describeCertificate(cert, lintNow).NameConstraints
	if nc == nil || !nc.Critical || !slices.Equal(nc.PermittedDNS, []string{".codemowers.io"}) || !slices.Equal(nc.ExcludedDNS, []string{"evil.codemowers.io"}) {
		t.Fatalf("name constraints = %+v", nc)
	}
}

func TestLegacyRootFindingsAreInformational(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	cert := selfSignedCA(t, key, big.NewInt(0x3ff), func(c *x509.Certificate) {
		c.NotBefore = time.Date(2006, 1, 1, 0, 0, 0, 0, time.UTC)
		c.SignatureAlgorithm = x509.SHA1WithRSA
	})
	got := codes(describeCertificate(cert, lintNow))
	for _, want := range []string{"info:short-serial", "info:weak-signature-hash"} {
		if !slices.Contains(got, want) {
			t.Errorf("findings %v lack %s", got, want)
		}
	}
}
