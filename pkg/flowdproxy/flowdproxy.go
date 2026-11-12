// Package flowdproxy reverse-proxies the flowd (Node workflow daemon) API
// under /api/flowd/ so the web UI talks to a single origin. flowd is optional:
// when AF_FLOWD_URL is unset the proxy mounts nothing and workflow features
// simply report unavailable.
package flowdproxy

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

// Target returns the flowd base URL from AF_FLOWD_URL ("" when unset).
func Target() string {
	return strings.TrimRight(os.Getenv("AF_FLOWD_URL"), "/")
}

// Mount registers a reverse proxy on mux for /api/flowd/* when flowd is
// configured. Returns true when mounted.
func Mount(mux *http.ServeMux) bool {
	base := Target()
	if base == "" {
		return false
	}
	target, err := url.Parse(base)
	if err != nil {
		log.Printf("[flowdproxy] invalid AF_FLOWD_URL %q: %v", base, err)
		return false
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.SetXForwarded()
			pr.Out.URL.Path = strings.TrimPrefix(pr.In.URL.Path, "/api/flowd")
		},
		Transport: &http.Transport{
			MaxIdleConns:          16,
			IdleConnTimeout:       90 * time.Second,
			ResponseHeaderTimeout: 120 * time.Second,
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("[flowdproxy] %s %s: %v", r.Method, r.URL.Path, err)
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"error":{"code":"flowd_unreachable","message":"flowd service is not reachable"}}`))
		},
	}
	mux.Handle("/api/flowd/", proxy)
	return true
}
