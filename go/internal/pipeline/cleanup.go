package pipeline

import (
	"log/slog"
	"os"
)

// CleanupLocalDir removes a temporary directory tree, logging but not failing
// on errors. Always safe to call even if the dir was never created.
func CleanupLocalDir(dir string) {
	if err := os.RemoveAll(dir); err != nil {
		slog.Warn("cleanup: failed to remove temp dir", "dir", dir, "err", err)
	}
}
