package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"

	"github.com/joho/godotenv"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

// auth-google: one-time OAuth2 consent flow.
// Starts a localhost:3000 server, opens the consent URL, catches the callback,
// exchanges the code for a refresh token, and prints it.
// Mirrors scripts/auth-google.ts.

var scopes = []string{
	"https://www.googleapis.com/auth/drive",
	"https://www.googleapis.com/auth/documents",
}

func main() {
	_ = godotenv.Load()

	clientID := os.Getenv("GOOGLE_CLIENT_ID")
	clientSecret := os.Getenv("GOOGLE_CLIENT_SECRET")
	if clientID == "" || clientSecret == "" {
		slog.Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env")
		os.Exit(1)
	}

	cfg := &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		RedirectURL:  "http://localhost:3000/callback",
		Scopes:       scopes,
		Endpoint:     google.Endpoint,
	}

	authURL := cfg.AuthCodeURL("state", oauth2.AccessTypeOffline, oauth2.ApprovalForce)
	fmt.Println("\n🔗 Open this URL in your browser to authorise:\n")
	fmt.Println(authURL)
	fmt.Println("\nWaiting for the OAuth callback on http://localhost:3000/callback ...\n")

	codeCh := make(chan string, 1)

	ln, err := net.Listen("tcp", ":3000")
	if err != nil {
		slog.Error("failed to listen on :3000", "err", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		if code == "" {
			http.Error(w, "no code in query", http.StatusBadRequest)
			return
		}
		fmt.Fprintln(w, "✅ Authorised! You can close this tab.")
		codeCh <- code
	})

	srv := &http.Server{Handler: mux}
	go srv.Serve(ln) //nolint:errcheck

	code := <-codeCh
	srv.Shutdown(context.Background()) //nolint:errcheck

	token, err := cfg.Exchange(context.Background(), code)
	if err != nil {
		slog.Error("token exchange failed", "err", err)
		os.Exit(1)
	}

	fmt.Println("\n✅ Success! Add this to your .env:\n")
	fmt.Printf("GOOGLE_REFRESH_TOKEN=%s\n", token.RefreshToken)

	// Also pretty-print the full token for reference
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	fmt.Println("\nFull token (for reference):")
	enc.Encode(token) //nolint:errcheck
}
