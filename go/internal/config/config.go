package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

// Config holds all validated environment variables.
// The .env file is loaded from the working directory (same file as the TS bot).
type Config struct {
	// WhatsApp
	AllowedJIDs     []string
	WhatsmeowDBPath string

	// Google OAuth2
	GoogleClientID     string
	GoogleClientSecret string
	GoogleRefreshToken string

	// Google Docs templates
	TemplateIDIG   string
	TemplateIDIGFB string

	// Google Drive
	OutputFolderID string

	// Behaviour
	TriggerURL          string
	OutputDocPermission string
	PairingTimeout      time.Duration
}

// Load reads and validates the .env file, then validates all required variables.
// Exits the process with a descriptive error if any required var is missing or invalid.
func Load() *Config {
	// Load .env — ignore error if file doesn't exist (env vars may already be set)
	_ = godotenv.Load()

	var errs []string
	require := func(key string) string {
		v := strings.TrimSpace(os.Getenv(key))
		if v == "" {
			errs = append(errs, fmt.Sprintf("  missing or empty: %s", key))
		}
		return v
	}
	withDefault := func(key, def string) string {
		v := strings.TrimSpace(os.Getenv(key))
		if v == "" {
			return def
		}
		return v
	}

	rawJIDs := require("ALLOWED_JIDS")
	whatsmeowDB := withDefault("WHATSMEOW_DB_PATH", "./data/whatsmeow.db")

	googleClientID := require("GOOGLE_CLIENT_ID")
	googleClientSecret := require("GOOGLE_CLIENT_SECRET")
	googleRefreshToken := require("GOOGLE_REFRESH_TOKEN")

	templateIG := require("TEMPLATE_ID_IG")
	templateIGFB := require("TEMPLATE_ID_IG_FB")

	outputFolderID := require("OUTPUT_FOLDER_ID")
	triggerURL := require("TRIGGER_URL")

	// OUTPUT_DOC_PERMISSION — last definition wins (mirrors .env behaviour)
	permission := withDefault("OUTPUT_DOC_PERMISSION", "reader")
	validPerms := map[string]bool{"reader": true, "commenter": true, "writer": true}
	if !validPerms[permission] {
		errs = append(errs, fmt.Sprintf("  invalid OUTPUT_DOC_PERMISSION %q (must be reader, commenter, or writer)", permission))
	}

	// PAIRING_TIMEOUT_MS
	pairingMS := withDefault("PAIRING_TIMEOUT_MS", "120000")
	pairingMSInt, err := strconv.Atoi(pairingMS)
	if err != nil {
		errs = append(errs, fmt.Sprintf("  invalid PAIRING_TIMEOUT_MS %q: must be an integer", pairingMS))
		pairingMSInt = 120000
	}

	if len(errs) > 0 {
		fmt.Fprintf(os.Stderr, "❌ Invalid configuration:\n%s\n", strings.Join(errs, "\n"))
		os.Exit(1)
	}

	// Split and trim JIDs
	jidParts := strings.Split(rawJIDs, ",")
	jids := make([]string, 0, len(jidParts))
	for _, j := range jidParts {
		j = strings.TrimSpace(j)
		if j != "" {
			jids = append(jids, j)
		}
	}

	return &Config{
		AllowedJIDs:         jids,
		WhatsmeowDBPath:     whatsmeowDB,
		GoogleClientID:      googleClientID,
		GoogleClientSecret:  googleClientSecret,
		GoogleRefreshToken:  googleRefreshToken,
		TemplateIDIG:        templateIG,
		TemplateIDIGFB:      templateIGFB,
		OutputFolderID:      outputFolderID,
		TriggerURL:          triggerURL,
		OutputDocPermission: permission,
		PairingTimeout:      time.Duration(pairingMSInt) * time.Millisecond,
	}
}
