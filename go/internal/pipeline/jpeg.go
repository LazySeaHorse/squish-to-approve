package pipeline

import (
	"image"
	_ "image/gif"  // register GIF decoder
	"image/jpeg"
	_ "image/png"  // register PNG decoder
	"os"
)

// ConvertToJPEG decodes an image from srcPath, encodes it as a JPEG with specified quality,
// and saves it to destPath.
func ConvertToJPEG(srcPath, destPath string, quality int) error {
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

	return jpeg.Encode(df, img, &jpeg.Options{
		Quality: quality,
	})
}
