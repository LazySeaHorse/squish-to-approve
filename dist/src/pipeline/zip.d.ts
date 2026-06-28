export interface ZipValidationError {
    kind: 'wrong_naming' | 'too_many' | 'empty' | 'missing_numbers';
    message: string;
}
export interface ExtractedImages {
    files: string[];
}
export declare function extractAndValidateZip(zipPath: string, destDir: string): ExtractedImages | ZipValidationError;
//# sourceMappingURL=zip.d.ts.map