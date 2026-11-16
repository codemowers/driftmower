//go:build !linux

package main

import (
	"errors"
	"github.com/codemowers/driftmower/desktop/dashboard"
)

func installDesktop(*dashboard.ChromeProfiles, string) error {
	return errors.New("desktop launcher installation is supported on Linux")
}
