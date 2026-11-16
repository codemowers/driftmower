package main

import "embed"

// desktopIcon is installed with the Linux desktop launcher.
//
//go:embed icon.svg
var desktopIcon []byte

// Include Next.js files beginning with underscores, especially _next.
//
//go:embed all:frontend
var frontend embed.FS
