// driftmower-dashboard serves static browser assets and public configuration.
// It has no API proxy, session store, OAuth secret or Kubernetes credentials.
package main

import (
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/codemowers/driftmower/desktop/dashboard"
)

func main() {
	cfg := dashboard.LoadConfig(os.Args[1:])
	if cfg.FlagError != nil {
		if errors.Is(cfg.FlagError, flag.ErrHelp) {
			return
		}
		log.Fatal(cfg.FlagError)
	}
	db := dashboard.New(cfg)
	server := &http.Server{Addr: cfg.ListenAddr, Handler: db.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	log.Printf("Serving static dashboard on %s", cfg.ListenAddr)
	log.Fatal(server.ListenAndServe())
}
