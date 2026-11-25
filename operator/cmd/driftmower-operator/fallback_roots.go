package main

// The image is FROM scratch and relies on the cluster to mount CA
// certificates. Where nothing is mounted, verify TLS with these embedded
// Mozilla roots instead of failing every HTTPS request; a mounted system
// bundle, including private CAs, still takes precedence.
import _ "golang.org/x/crypto/x509roots/fallback"
