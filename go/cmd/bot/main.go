package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"squish-to-approve/internal/config"
	"squish-to-approve/internal/google"
	"squish-to-approve/internal/whatsapp"
)

func main() {
	cfg := config.Load()

	ctx := context.Background()
	httpClient := google.NewOAuthClient(ctx, cfg)

	slog.Info("starting squish-to-approve bot")

	waClient, err := whatsapp.New(ctx, cfg, httpClient)
	if err != nil {
		slog.Error("failed to start WhatsApp client", "err", err)
		os.Exit(1)
	}
	defer waClient.Disconnect()

	slog.Info("bot running — press Ctrl+C to stop")

	// Block until SIGINT or SIGTERM
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	slog.Info("shutting down gracefully")
}
