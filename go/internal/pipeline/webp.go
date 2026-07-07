package pipeline

import (
	"image"
	_ "image/jpeg" // register JPEG decoder
	_ "image/png"  // register PNG decoder
	"os"

	"github.com/chai2010/webp"
)

// ConvertToWebP decodes a JPEG/PNG image from srcPath, encodes it as a WebP image with specified quality,
// and saves it to destPath.
func ConvertToWebP(srcPath, destPath string, quality float32) error {
	sf, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer sf.Close()

	img, _, err := image.Decode(sf)
	if err != nil {
		return err
	}

	df, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer df.Close()

	return webp.Encode(df, img, &webp.Options{
		Lossless: false,
		Quality:  quality,
	})
}
