package google

import (
	"context"
	"net/http"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"squish-to-approve/internal/config"
)

// driveScope and docsScope are the only permissions needed.
var scopes = []string{
	"https://www.googleapis.com/auth/drive",
	"https://www.googleapis.com/auth/documents",
}

// NewOAuthClient returns an *http.Client that automatically refreshes the
// access token using the stored refresh token — identical behaviour to the TS
// google.auth.OAuth2 client with setCredentials({ refresh_token }).
func NewOAuthClient(ctx context.Context, cfg *config.Config) *http.Client {
	oauthCfg := &oauth2.Config{
		ClientID:     cfg.GoogleClientID,
		ClientSecret: cfg.GoogleClientSecret,
		Endpoint:     google.Endpoint,
		Scopes:       scopes,
	}
	token := &oauth2.Token{
		RefreshToken: cfg.GoogleRefreshToken,
	}
	// TokenSource will fetch/refresh the access token lazily on first use.
	ts := oauthCfg.TokenSource(ctx, token)
	return oauth2.NewClient(ctx, ts)
}
